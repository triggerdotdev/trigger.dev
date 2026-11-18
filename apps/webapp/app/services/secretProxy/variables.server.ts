import { boundedIn, Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import {
  environmentSecretPrefix,
  protectedSecretKeys,
} from "../environmentEncryption/secretStore.server";
import { proxyConfigHosts } from "./placeholder.server";

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

export type EffectiveEnvironmentVariable = Awaited<
  ReturnType<typeof effectiveEnvironmentVariables>
>[number];

export async function assertVariablesNotProxyOnly(
  db: PrismaClientOrTransaction,
  projectId: string,
  environmentIds: string[],
  keys: string[]
) {
  if (!keys.length) return;
  // Serialize policy enrollment with mutation transactions, including inherited child overrides.
  await db
    .$queryRaw(
      Prisma.sql`SELECT id FROM "EnvironmentVariable" WHERE "projectId" = ${projectId} AND key = ANY(${keys}::text[]) ORDER BY id FOR UPDATE`
    )
    .catch((error: unknown) => {
      recordSecretProxyFailure("metadata", "dependency");
      throw error;
    });
  const protectedKeys = await protectedSecretKeys(db, projectId, environmentIds);
  if (
    environmentIds.some((id) =>
      keys.some((key) => protectedKeys.has(`${environmentSecretPrefix(projectId, id)}${key}`))
    )
  ) {
    recordSecretProxyFailure("guard", "policy");
    throw new Error("Proxy-only variables can only be changed by the secret proxy operator");
  }
}
