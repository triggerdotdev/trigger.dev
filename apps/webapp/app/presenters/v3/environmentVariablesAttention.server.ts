import { Prisma, type RuntimeEnvironmentType } from "@trigger.dev/database";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { sqlDatabaseSchema } from "~/db.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { OIDC_REPLACEABLE_KEYS } from "~/v3/environmentVariables/oidcReplaceable";
import {
  IGNORED_ATTENTION_VIEW,
  type AttentionKind,
  type AttentionView,
} from "~/v3/environmentVariables/attention";
import { getReadableVariableValues } from "./readableVariableValues.server";

// The same pattern Prisma builds for `contains`, which the rest of the list uses.
function keySearch(alias: Prisma.Sql, search: string | undefined) {
  return search ? Prisma.sql`AND ${alias}."key" ILIKE ${`%${search}%`}` : Prisma.empty;
}

/** What the page looks for in one environment. A kind left out matches nothing. */
export type AttentionConditions = {
  projectId: string;
  targetId: string;
  /** "Missing here": keys set in one of these environments (the project's own) and not in the target. */
  missingSourceIds: string[];
  /** "Changed recently": values in the target updated since then. */
  recentSince: Date;
  /** "Replace with OIDC": keys of the target with these names. Undefined without OIDC. */
  oidcKeys?: string[];
  /** "Empty": these variables, found empty by `findEmptyValues`. Undefined when not read. */
  emptyIds?: string[];
  search?: string;
};

/**
 * One row per variable of the project, with the target's value joined (null when the key isn't
 * set there) and a flag per kind. Reads the project's variables by the (projectId, key) index, the
 * target's and the sources' values by the environmentId index, and hash-joins them: a correlated
 * per-key probe is planned at a cost high enough to switch on JIT compilation.
 *
 * A kind the team ignored for the key in the target is off, and its `ignored*` flag is on instead.
 * An ignore of a kind that doesn't apply (a Missing here key since set) sets neither.
 */
function flaggedVariables(conditions: AttentionConditions) {
  const { projectId, targetId, missingSourceIds, recentSince, oidcKeys, emptyIds, search } =
    conditions;
  return Prisma.sql`
    SELECT raw."id", raw."key", raw."updatedAt", raw."recent",
      raw."missing" AND NOT raw."ignoresMissing" AS "missing",
      raw."oidc" AND NOT raw."ignoresOidc" AS "oidc",
      raw."empty" AND NOT raw."ignoresEmpty" AS "empty",
      raw."missing" AND raw."ignoresMissing" AS "ignoredMissing",
      raw."oidc" AND raw."ignoresOidc" AS "ignoredOidc",
      raw."empty" AND raw."ignoresEmpty" AS "ignoredEmpty"
    FROM (
      SELECT var."id", var."key", target."updatedAt",
        (target."id" IS NULL AND source."variableId" IS NOT NULL) AS "missing",
        (target."updatedAt" >= ${recentSince}) IS TRUE AS "recent",
        ${
          oidcKeys
            ? Prisma.sql`(target."id" IS NOT NULL AND var."key" = ANY(${oidcKeys}::text[]))`
            : Prisma.sql`false`
        } AS "oidc",
        ${emptyIds ? Prisma.sql`var."id" = ANY(${emptyIds}::text[])` : Prisma.sql`false`} AS "empty",
        COALESCE(ignores."missing", false) AS "ignoresMissing",
        COALESCE(ignores."oidc", false) AS "ignoresOidc",
        COALESCE(ignores."empty", false) AS "ignoresEmpty"
      FROM ${sqlDatabaseSchema}."EnvironmentVariable" AS var
      LEFT JOIN ${sqlDatabaseSchema}."EnvironmentVariableValue" AS target
        ON target."variableId" = var."id" AND target."environmentId" = ${targetId}
      LEFT JOIN (
        SELECT DISTINCT "variableId" FROM ${sqlDatabaseSchema}."EnvironmentVariableValue"
        WHERE "environmentId" = ANY(${missingSourceIds}::text[])
      ) AS source ON source."variableId" = var."id"
      LEFT JOIN (
        SELECT "variableId",
          bool_or("reason" = 'MISSING') AS "missing",
          bool_or("reason" = 'OIDC') AS "oidc",
          bool_or("reason" = 'EMPTY') AS "empty"
        FROM ${sqlDatabaseSchema}."EnvironmentVariableIgnore"
        WHERE "environmentId" = ${targetId}
        GROUP BY "variableId"
      ) AS ignores ON ignores."variableId" = var."id"
      WHERE var."projectId" = ${projectId}
        ${keySearch(Prisma.sql`var`, search)}
    ) AS raw
  `;
}

const ANY_KIND = Prisma.sql`(flagged."empty" OR flagged."missing" OR flagged."recent" OR flagged."oidc")`;
const ANY_IGNORED = Prisma.sql`(flagged."ignoredEmpty" OR flagged."ignoredMissing" OR flagged."ignoredOidc")`;

/** Per kind, and for every kind (`all`), keys still needing attention; `ignored`: keys with an ignored reason. */
export type AttentionCounts = Record<AttentionKind | "all" | "ignored", number>;

/** How many keys each kind has, and how many have any (a key can have several). One read. */
export async function countAttentionKeys(
  replica: PrismaReplicaClient,
  conditions: AttentionConditions
): Promise<AttentionCounts> {
  const [row] = await replica.$queryRaw<AttentionCounts[]>`
    SELECT
      (count(*) FILTER (WHERE flagged."empty"))::int AS "empty",
      (count(*) FILTER (WHERE flagged."missing"))::int AS "missing",
      (count(*) FILTER (WHERE flagged."recent"))::int AS "recent",
      (count(*) FILTER (WHERE flagged."oidc"))::int AS "oidc",
      (count(*) FILTER (WHERE ${ANY_KIND}))::int AS "all",
      (count(*) FILTER (WHERE ${ANY_IGNORED}))::int AS "ignored"
    FROM (${flaggedVariables(conditions)}) AS flagged
  `;
  return row ?? { empty: 0, missing: 0, recent: 0, oidc: 0, all: 0, ignored: 0 };
}

export type AttentionKeyRow = { id: string } & Record<AttentionKind, boolean> & {
    /** The kinds the team ignored that would otherwise show. */
    ignoredEmpty: boolean;
    ignoredMissing: boolean;
    ignoredOidc: boolean;
  };

/**
 * One page of the keys of a kind (every kind when `kind` is undefined), each with its kinds.
 * Alphabetical by key; "Changed recently" newest first. Every kind is ordered by the key's most
 * pressing kind first (missing, empty, OIDC, recent), so a group carries on across pages.
 * `ignored` lists the keys with an ignored kind, by key.
 */
export async function attentionKeysPage(
  replica: PrismaReplicaClient,
  {
    kind,
    skip,
    take,
    ...conditions
  }: AttentionConditions & { kind?: AttentionView; skip: number; take: number }
): Promise<AttentionKeyRow[]> {
  const where =
    kind === IGNORED_ATTENTION_VIEW
      ? ANY_IGNORED
      : kind
        ? Prisma.sql`flagged.${Prisma.raw(`"${kind}"`)}`
        : ANY_KIND;
  const order =
    kind === "recent"
      ? Prisma.sql`flagged."updatedAt" DESC, flagged."key" ASC`
      : kind
        ? Prisma.sql`flagged."key" ASC`
        : // Missing and empty never overlap (empty needs a value here); the page's REASON_ORDER.
          Prisma.sql`CASE WHEN flagged."missing" THEN 0 WHEN flagged."empty" THEN 1
            WHEN flagged."oidc" THEN 2 ELSE 3 END, flagged."key" ASC`;
  return replica.$queryRaw<AttentionKeyRow[]>`
    SELECT flagged."id", flagged."empty", flagged."missing", flagged."recent", flagged."oidc",
      flagged."ignoredEmpty", flagged."ignoredMissing", flagged."ignoredOidc"
    FROM (${flaggedVariables(conditions)}) AS flagged
    WHERE ${where}
    ORDER BY ${order}
    OFFSET ${skip}
    LIMIT ${take}
  `;
}

export type EmptyValuesResult =
  | { kind: "ok"; values: Array<{ id: string; key: string; updatedAt: Date }> }
  /** The environment has more values than one request may decrypt. */
  | { kind: "tooManyKeys"; max: number }
  /** The environment's encryption key can't be read. */
  | { kind: "unavailable" };

/**
 * The environment's values that are empty or only whitespace, secrets included. Values live
 * encrypted, so this reads and decrypts every value in the environment (matching `search`), and
 * refuses when there are more than `maxKeys` of them.
 */
export async function findEmptyValues(
  prismaClient: PrismaClient,
  replica: PrismaReplicaClient,
  {
    projectId,
    environmentId,
    search,
    maxKeys,
  }: { projectId: string; environmentId: string; search?: string; maxKeys: number }
): Promise<EmptyValuesResult> {
  const stored = await replica.$queryRaw<{ id: string; key: string; updatedAt: Date }[]>`
    SELECT var."id", var."key", val."updatedAt"
    FROM ${sqlDatabaseSchema}."EnvironmentVariableValue" AS val
    JOIN ${sqlDatabaseSchema}."EnvironmentVariable" AS var ON var."id" = val."variableId"
    WHERE val."environmentId" = ${environmentId}
      -- Lets the planner read the project's variables by index instead of the whole table.
      AND var."projectId" = ${projectId}
      ${keySearch(Prisma.sql`var`, search)}
    LIMIT ${maxKeys + 1}
  `;
  if (stored.length > maxKeys) {
    return { kind: "tooManyKeys", max: maxKeys };
  }

  const repository = new EnvironmentVariablesRepository(prismaClient, replica);
  const { values, unavailableEnvironments } = await getReadableVariableValues(
    repository,
    projectId,
    stored.map((row) => ({ environmentId, key: row.key }))
  );
  if (unavailableEnvironments.has(environmentId)) {
    return { kind: "unavailable" };
  }

  // A value the read doesn't return (a proxy-only secret) isn't known to be empty.
  return {
    kind: "ok",
    values: stored.filter((row) => {
      const value = values.get(`${environmentId}:${row.key}`);
      return value !== undefined && value.trim() === "";
    }),
  };
}

export type OidcReplaceableValue = {
  key: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  /** Set on a preview branch. */
  branchName: string | null;
};

/**
 * Where the project sets a key OIDC could replace, in deployed environments only: OIDC tokens
 * aren't available in Development. Archived branches are left out.
 */
export async function findOidcReplaceableValues(
  replica: PrismaReplicaClient,
  { projectId }: { projectId: string }
): Promise<OidcReplaceableValue[]> {
  return replica.$queryRaw<OidcReplaceableValue[]>`
    SELECT var."key", env."id" AS "environmentId", env."type" AS "environmentType",
      env."branchName"
    FROM ${sqlDatabaseSchema}."EnvironmentVariable" AS var
    JOIN ${sqlDatabaseSchema}."EnvironmentVariableValue" AS val ON val."variableId" = var."id"
    JOIN ${sqlDatabaseSchema}."RuntimeEnvironment" AS env ON env."id" = val."environmentId"
    WHERE var."projectId" = ${projectId}
      AND var."key" = ANY(${OIDC_REPLACEABLE_KEYS}::text[])
      AND env."type" <> 'DEVELOPMENT'
      AND env."archivedAt" IS NULL
    ORDER BY var."key" ASC
  `;
}
