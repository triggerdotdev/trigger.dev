import { boundedIn, Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { environmentSecretPrefix } from "../environmentEncryption/secretStore.server";
import {
  proxyConfigHosts,
  SECRET_PROXY_MAX_CREDENTIAL_BYTES,
  secretProxyExecutionHosts,
} from "./placeholder.server";

import { recordSecretProxyFailure } from "./telemetry.server";

export const MAX_PROXY_VARIABLES = 512;

// Values and policies are selected before any secret-store read or decryption.
export async function effectiveEnvironmentVariables(
  db: PrismaClientOrTransaction,
  projectId: string,
  environmentId: string,
  parentEnvironmentId?: string
) {
  const environment = await db.runtimeEnvironment.findFirst({
    where: { id: environmentId, projectId },
    select: { parentEnvironmentId: true },
  });
  if (
    !environment ||
    (parentEnvironmentId && parentEnvironmentId !== environment.parentEnvironmentId)
  ) {
    throw new Error("Invalid environment variable scope");
  }
  const parentId = environment.parentEnvironmentId;
  const rows = await db.environmentVariableValue.findMany({
    orderBy: { id: "asc" },
    where: {
      environmentId: { in: boundedIn(parentId ? [parentId, environmentId] : [environmentId]) },
      variable: { projectId },
      environment: { projectId },
    },
    select: {
      id: true,
      variableId: true,
      environmentId: true,
      version: true,
      isSecret: true,
      isProxyOnly: true,
      proxyConfig: true,
      variable: { select: { key: true } },
    },
  });
  const values = effectiveProxyValues(rows, environmentId, parentId);
  if (values.filter((value) => value.isProxyOnly).length > MAX_PROXY_VARIABLES) {
    throw new Error("Too many secret proxy variables");
  }
  return values.map((value) => ({
    ...value,
    key: value.variable.key,
    secretKey: `${environmentSecretPrefix(projectId, value.environmentId)}${value.variable.key}`,
  }));
}

export function effectiveProxyValues<
  T extends {
    variableId: string;
    environmentId: string;
    isProxyOnly: boolean;
    proxyConfig: unknown;
  },
>(rows: T[], environmentId: string, parentEnvironmentId?: string | null) {
  type Effective = T & { proxyAllowedHosts: string[] };
  const withHosts = (row: T): Effective => ({
    ...row,
    proxyAllowedHosts: row.isProxyOnly ? proxyConfigHosts(row.proxyConfig) : [],
  });
  const effective = new Map<string, Effective>();
  for (const row of rows.filter((row) => row.environmentId === parentEnvironmentId))
    effective.set(row.variableId, withHosts(row));
  for (const row of rows.filter((row) => row.environmentId === environmentId)) {
    const inherited = effective.get(row.variableId);
    const own = withHosts(row);
    effective.set(
      row.variableId,
      inherited?.isProxyOnly
        ? {
            ...own,
            isProxyOnly: true,
            proxyAllowedHosts: row.isProxyOnly
              ? own.proxyAllowedHosts.filter((host) => inherited.proxyAllowedHosts.includes(host))
              : inherited.proxyAllowedHosts,
          }
        : own
    );
  }
  return [...effective.values()];
}

/**
 * The domains each value's runs may send it to, keyed by `${variableId}:${environmentId}`, for
 * values that are in Vault directly or through their parent environment. A branch's own value
 * under a Vault parent is in Vault too, and gets the parent's domains intersected with its own.
 * `inherited` when the parent's value is in Vault, so this one can't leave Vault on its own.
 */
export async function effectiveVaultHosts(
  db: PrismaClientOrTransaction,
  values: Array<{
    variableId: string;
    environmentId: string;
    isProxyOnly: boolean;
    proxyConfig: unknown;
  }>,
  environments: Array<{ id: string; parentEnvironmentId: string | null }>
): Promise<Map<string, { hosts: string[]; inherited: boolean }>> {
  const parentOf = new Map(environments.map((env) => [env.id, env.parentEnvironmentId]));
  const parented = values.filter((value) => parentOf.get(value.environmentId));
  const parents = parented.length
    ? await db.environmentVariableValue.findMany({
        where: {
          isProxyOnly: true,
          OR: parented.map((value) => ({
            variableId: value.variableId,
            environmentId: parentOf.get(value.environmentId)!,
          })),
        },
        select: { variableId: true, environmentId: true, proxyConfig: true },
      })
    : [];
  const parentHosts = new Map(
    parents.map((value) => [
      `${value.variableId}:${value.environmentId}`,
      proxyConfigHosts(value.proxyConfig),
    ])
  );
  const result = new Map<string, { hosts: string[]; inherited: boolean }>();
  for (const value of values) {
    const parentId = parentOf.get(value.environmentId);
    const inherited = parentId ? parentHosts.get(`${value.variableId}:${parentId}`) : undefined;
    const own = value.isProxyOnly ? proxyConfigHosts(value.proxyConfig) : undefined;
    const hosts =
      inherited && own ? own.filter((host) => inherited.includes(host)) : (own ?? inherited);
    if (hosts) {
      result.set(`${value.variableId}:${value.environmentId}`, {
        hosts,
        inherited: inherited !== undefined,
      });
    }
  }
  return result;
}

/**
 * Checks the Vault policy each run would get in these environments and in their active branches,
 * which intersect their own domains with the parent's. Call inside the write transaction.
 */
export async function assertVaultPoliciesValid(
  db: PrismaClientOrTransaction,
  projectId: string,
  environmentIds: string[]
) {
  if (!environmentIds.length) return;
  const environments = await db.runtimeEnvironment.findMany({
    where: { projectId, id: { in: boundedIn([...new Set(environmentIds)]) } },
    select: { id: true, parentEnvironmentId: true },
  });
  // A branch's policy depends on its parent's, so writes to either take the parent's lock: two
  // Vault writes that change the same policies run one after the other. An advisory lock, so
  // nothing else that updates the environment row waits on it.
  const roots = [...new Set(environments.map((env) => env.parentEnvironmentId ?? env.id))].sort();
  for (const root of roots) {
    await db.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`vault-policy:${root}`}, 0))`
    );
  }
  const branches = await db.runtimeEnvironment.findMany({
    where: {
      projectId,
      parentEnvironmentId: { in: boundedIn(environments.map((env) => env.id)) },
      archivedAt: null,
    },
    select: { id: true, parentEnvironmentId: true },
  });
  const checked = [...environments, ...branches];
  const scope = [...new Set(checked.flatMap((env) => [env.id, env.parentEnvironmentId ?? env.id]))];
  // One read for every environment checked, then each one's policy is worked out in memory.
  const rows = await db.environmentVariableValue.findMany({
    where: {
      environmentId: { in: boundedIn(scope) },
      variable: { projectId },
      OR: [{ isProxyOnly: true }, { environment: { parentEnvironmentId: { not: null } } }],
    },
    select: {
      variableId: true,
      environmentId: true,
      isProxyOnly: true,
      proxyConfig: true,
      variable: { select: { key: true } },
    },
  });
  const rowsByEnvironment = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = rowsByEnvironment.get(row.environmentId);
    if (bucket) bucket.push(row);
    else rowsByEnvironment.set(row.environmentId, [row]);
  }
  for (const env of checked) {
    const values = effectiveProxyValues(
      [
        ...(env.parentEnvironmentId ? (rowsByEnvironment.get(env.parentEnvironmentId) ?? []) : []),
        ...(rowsByEnvironment.get(env.id) ?? []),
      ],
      env.id,
      env.parentEnvironmentId
    ).filter((value) => value.isProxyOnly);
    if (values.length > MAX_PROXY_VARIABLES) {
      throw new Error("Too many Agent Vault values in one environment.");
    }
    const empty = values.find((value) => value.proxyAllowedHosts.length === 0);
    if (empty) {
      throw new Error(
        `${empty.variable.key} would have no allowed domains in a Preview branch. A branch can only use domains its Preview value also allows.`
      );
    }
    secretProxyExecutionHosts(values);
  }
}

/** Whether this variable is in Vault in any of these environments, directly or through a parent. */
export async function isInVault(
  db: PrismaClientOrTransaction,
  projectId: string,
  variableId: string,
  environmentIds: string[]
) {
  const environments = await db.runtimeEnvironment.findMany({
    where: { projectId, id: { in: boundedIn(environmentIds) } },
    select: { id: true, parentEnvironmentId: true },
  });
  const scope = environments.flatMap((environment) =>
    environment.parentEnvironmentId
      ? [environment.id, environment.parentEnvironmentId]
      : [environment.id]
  );
  return (
    (await db.environmentVariableValue.count({
      where: { variableId, isProxyOnly: true, environmentId: { in: boundedIn(scope) } },
    })) > 0
  );
}

/** The proxy refuses larger credentials, so a Vault value over the limit could never be sent. */
export function assertVaultValueSize(value: string) {
  if (Buffer.byteLength(value) > SECRET_PROXY_MAX_CREDENTIAL_BYTES) {
    throw new Error("This value is too large for Agent Vault.");
  }
}

export type EffectiveEnvironmentVariable = Awaited<
  ReturnType<typeof effectiveEnvironmentVariables>
>[number];

/**
 * Serializes writes to these keys, so a value moved into Vault is never written over by a save
 * that read it before the move. Includes inherited overrides.
 */
export async function lockVariableKeys(
  db: PrismaClientOrTransaction,
  projectId: string,
  keys: string[]
) {
  if (!keys.length) return [];
  return db
    .$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "EnvironmentVariable" WHERE "projectId" = ${projectId} AND key = ANY(${keys}::text[]) ORDER BY id FOR UPDATE`
    )
    .catch((error: unknown) => {
      recordSecretProxyFailure("metadata", "dependency");
      throw error;
    });
}
