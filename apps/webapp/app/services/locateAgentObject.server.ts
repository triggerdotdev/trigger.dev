import type { ClickHouse, ErrorGroupLocationsQueryResult } from "@internal/clickhouse";
import type { LocatedScope, LocateResult } from "@internal/dashboard-agent-contracts";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn, Prisma, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { $replica, sqlDatabaseSchema } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { dashboardAgentEnvironmentAddress } from "~/services/dashboardAgentEnvironmentAddress.server";
import { logger } from "~/services/logger.server";
import { runStore } from "~/v3/runStore.server";

// Org membership is verified by the route builder; this service assumes the route is the only caller.
export type AuthenticatedOrgActor = { userId: string; organizationId: string };

// Shared by `error` and `queue`; exported so tests can seed exactly one past the cap.
export const MAX_LOCATIONS = 200;

// Overflow here only risks a flagged false negative — Postgres stays the visibility authority.
const MAX_EXCLUDED_DEV_ENVIRONMENTS = 500;

// Exceeding this fails closed (`unavailable`) rather than searching a truncated environment set.
const MAX_VISIBLE_ENVIRONMENTS = 5000;

const ENVIRONMENT_SCOPE_SELECT = {
  id: true,
  slug: true,
  type: true,
  branchName: true,
  organizationId: true,
  project: { select: { externalRef: true } },
} as const;

type EnvironmentScopeRow = Prisma.RuntimeEnvironmentGetPayload<{
  select: typeof ENVIRONMENT_SCOPE_SELECT;
}>;

function toScope(
  environment: EnvironmentScopeRow,
  extra: {
    taskIdentifier?: string;
    version?: string;
    shortCode?: string;
    queueName?: string;
    queueType?: "task" | "custom";
  } = {}
): LocatedScope {
  // The dashboard URL slug isn't the agent's vocabulary — staging's slug is "stg".
  const address = dashboardAgentEnvironmentAddress(environment);
  return {
    projectRef: environment.project.externalRef,
    environmentName: address.environmentName ?? environment.slug,
    environmentId: environment.id,
    ...(address.environmentBranch ? { branch: address.environmentBranch } : {}),
    ...(extra.taskIdentifier ? { taskIdentifier: extra.taskIdentifier } : {}),
    ...(extra.version ? { version: extra.version } : {}),
    ...(extra.shortCode ? { shortCode: extra.shortCode } : {}),
    ...(extra.queueName ? { queueName: extra.queueName } : {}),
    ...(extra.queueType ? { queueType: extra.queueType } : {}),
  };
}

// A colleague's dev environment is private (a departed member's stays private too, since
// `orgMemberId` goes null rather than reassigned); `extra` lets callers add clauses without forking this.
export function environmentVisibilityFilter<Extra extends object = object>(
  actor: AuthenticatedOrgActor,
  extra?: Extra
) {
  return {
    organizationId: actor.organizationId,
    archivedAt: null,
    project: { deletedAt: null },
    OR: [{ type: { not: "DEVELOPMENT" as const } }, { orgMember: { userId: actor.userId } }],
    ...extra,
  };
}

// The `re."orgMemberId" = om."id"` join is written against a `re` alias supplied by the caller.
function ownedByActorSubquery(actor: AuthenticatedOrgActor) {
  return Prisma.sql`
    SELECT 1 FROM ${sqlDatabaseSchema}."OrgMember" om
    WHERE om."id" = re."orgMemberId" AND om."userId" = ${actor.userId}
  `;
}

// Every environment visible to the actor, resolved by an indexed `organizationId` filter.
// `overflowed` signals more than `maxVisibleEnvironments` — the caller must fail closed.
async function visibleEnvironmentIds(
  actor: AuthenticatedOrgActor,
  maxVisibleEnvironments: number = MAX_VISIBLE_ENVIRONMENTS
): Promise<{ ids: string[]; overflowed: boolean }> {
  // `= ANY(...::text[])` binds the id list as one parameter, unlike Prisma's `in:` (one per id).
  const environments = await $replica.$queryRaw<{ id: string }[]>`
    SELECT re."id"
    FROM ${sqlDatabaseSchema}."RuntimeEnvironment" re
    JOIN ${sqlDatabaseSchema}."Project" p ON p."id" = re."projectId"
    WHERE re."organizationId" = ${actor.organizationId}
      AND re."archivedAt" IS NULL
      AND p."deletedAt" IS NULL
      AND (
        re."type" <> 'DEVELOPMENT'
        OR EXISTS (${ownedByActorSubquery(actor)})
      )
    ORDER BY re."id" ASC
    LIMIT ${maxVisibleEnvironments + 1}
  `;
  const overflowed = environments.length > maxVisibleEnvironments;
  return {
    ids: (overflowed ? environments.slice(0, maxVisibleEnvironments) : environments).map(
      (environment) => environment.id
    ),
    overflowed,
  };
}

async function locateRun(id: string, actor: AuthenticatedOrgActor): Promise<LocateResult> {
  // The run-ops split db has no `runtimeEnvironment` relation, only the scalar FK column.
  const run = await runStore.findRun(
    { friendlyId: id },
    { select: { runtimeEnvironmentId: true } },
    $replica
  );
  if (!run) return { found: false };

  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: run.runtimeEnvironmentId, ...environmentVisibilityFilter(actor) },
    select: ENVIRONMENT_SCOPE_SELECT,
  });
  if (!environment) return { found: false };

  return { found: true, kind: "run", id, scopes: [toScope(environment)] };
}

async function locateDeployment(id: string, actor: AuthenticatedOrgActor): Promise<LocateResult> {
  const deployment = await $replica.workerDeployment.findFirst({
    where: { friendlyId: id, environment: environmentVisibilityFilter(actor) },
    select: {
      version: true,
      shortCode: true,
      environment: { select: ENVIRONMENT_SCOPE_SELECT },
    },
    orderBy: { id: "asc" },
  });
  if (!deployment) return { found: false };

  // `get_deploy`'s `version` param accepts either, so the agent can follow up with either.
  const scope = toScope(deployment.environment, {
    version: deployment.version,
    shortCode: deployment.shortCode,
  });

  return { found: true, kind: "deployment", id, scopes: [scope] };
}

function queryLocations(
  clickhouse: ClickHouse,
  organizationId: string,
  fingerprint: string,
  excludedEnvironmentIds: string[]
) {
  const queryBuilder = clickhouse.errors.locationsQueryBuilder();
  queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
  queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
  if (excludedEnvironmentIds.length > 0) {
    queryBuilder.where("environment_id NOT IN {excludedEnvironmentIds: Array(String)}", {
      excludedEnvironmentIds,
    });
  }
  queryBuilder.groupBy("environment_id, task_identifier");
  queryBuilder.orderBy("environment_id, task_identifier");
  queryBuilder.limit(MAX_LOCATIONS + 1);
  return queryBuilder.execute();
}

// One ClickHouse query resolves every `(environment, task)` pair; the `NOT IN` exclusion is a
// pre-cap optimization only — `environmentVisibilityFilter` below is the privacy check.
async function locateError(
  id: string,
  actor: AuthenticatedOrgActor,
  // Overridable only for tests, which inject a small cap rather than seed hundreds of orgMembers.
  maxExcludedDevEnvironments: number = MAX_EXCLUDED_DEV_ENVIRONMENTS
): Promise<LocateResult> {
  // A malformed id resolves to "not found" rather than a 500, since the route admits any string.
  let fingerprint: string;
  try {
    fingerprint = ErrorId.toId(id);
  } catch {
    return { found: false };
  }

  const excludableDevEnvironments = await $replica.$queryRaw<{ id: string }[]>`
    SELECT re."id"
    FROM ${sqlDatabaseSchema}."RuntimeEnvironment" re
    WHERE re."organizationId" = ${actor.organizationId}
      AND re."type" = 'DEVELOPMENT'
      AND NOT EXISTS (${ownedByActorSubquery(actor)})
    ORDER BY re."id" ASC
    LIMIT ${maxExcludedDevEnvironments + 1}
  `;
  const exclusionOverflowed = excludableDevEnvironments.length > maxExcludedDevEnvironments;
  const excludedEnvironmentIds = excludableDevEnvironments
    .slice(0, maxExcludedDevEnvironments)
    .map((environment) => environment.id);

  let fetched: ErrorGroupLocationsQueryResult[] | null;
  try {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      actor.organizationId,
      "logs"
    );
    const [queryError, rows] = await queryLocations(
      clickhouse,
      actor.organizationId,
      fingerprint,
      excludedEnvironmentIds
    );
    if (queryError) throw queryError;
    fetched = rows;
  } catch (error) {
    logger.error("Failed to locate an error fingerprint", { error, fingerprint });
    return { found: false, unavailable: true };
  }
  if (!fetched || fetched.length === 0) return { found: false };

  const capOverflowed = fetched.length > MAX_LOCATIONS;
  const locations = capOverflowed ? fetched.slice(0, MAX_LOCATIONS) : fetched;

  const environmentIds = [...new Set(locations.map((location) => location.environment_id))];
  // Postgres stays the visibility authority after the ClickHouse lookup — this re-filter keeps private dev environments out.
  const environments = await $replica.runtimeEnvironment.findMany({
    where: { id: { in: boundedIn(environmentIds) }, ...environmentVisibilityFilter(actor) },
    select: ENVIRONMENT_SCOPE_SELECT,
  });
  const environmentById = new Map(environments.map((environment) => [environment.id, environment]));

  const scopes = locations
    .map((location) => {
      const environment = environmentById.get(location.environment_id);
      return environment
        ? toScope(environment, { taskIdentifier: location.task_identifier })
        : undefined;
    })
    .filter((scope): scope is LocatedScope => scope !== undefined);

  // Computed before the empty-scopes check: a truncated result must not report a confident "doesn't exist".
  const truncated = capOverflowed || exclusionOverflowed;
  if (scopes.length === 0) return truncated ? { found: false, truncated: true } : { found: false };

  return { found: true, kind: "error", id, scopes, ...(truncated ? { truncated: true } : {}) };
}

const TASK_QUEUE_PREFIX = "task/";

type QueueScopeRow = {
  name: string;
  environmentId: string;
  environmentSlug: string;
  environmentType: string;
  environmentBranchName: string | null;
  environmentOrganizationId: string;
  projectExternalRef: string;
};

// Queue names aren't unique across the org, so every matching visible scope is returned; a bare
// name tries both spellings since a plain name and its `task/`-prefixed form can each be stored.
// A name that already carries the prefix names a task queue and only that.
async function locateQueue(
  name: string,
  actor: AuthenticatedOrgActor,
  // Overridable only for tests, which inject a small cap rather than seed thousands of environments.
  maxVisibleEnvironments: number = MAX_VISIBLE_ENVIRONMENTS
): Promise<LocateResult> {
  const { ids: environmentIds, overflowed } = await visibleEnvironmentIds(
    actor,
    maxVisibleEnvironments
  );
  if (overflowed) return { found: false, unavailable: true };
  if (environmentIds.length === 0) return { found: false };

  const names = name.startsWith(TASK_QUEUE_PREFIX) ? [name] : [name, `${TASK_QUEUE_PREFIX}${name}`];

  // `= ANY(...)` hits `TaskQueue`'s `(runtimeEnvironmentId, name)` unique index.
  const rows = await $replica.$queryRaw<QueueScopeRow[]>`
    SELECT
      tq."name" AS "name",
      re."id" AS "environmentId",
      re."slug" AS "environmentSlug",
      re."type" AS "environmentType",
      re."branchName" AS "environmentBranchName",
      re."organizationId" AS "environmentOrganizationId",
      p."externalRef" AS "projectExternalRef"
    FROM ${sqlDatabaseSchema}."TaskQueue" tq
    JOIN ${sqlDatabaseSchema}."RuntimeEnvironment" re ON re."id" = tq."runtimeEnvironmentId"
    JOIN ${sqlDatabaseSchema}."Project" p ON p."id" = re."projectId"
    WHERE tq."runtimeEnvironmentId" = ANY(${environmentIds}::text[])
      AND tq."name" = ANY(${names}::text[])
    ORDER BY tq."runtimeEnvironmentId" ASC, tq."name" ASC
    LIMIT ${MAX_LOCATIONS + 1}
  `;
  if (rows.length === 0) return { found: false };

  const truncated = rows.length > MAX_LOCATIONS;
  const scopes = (truncated ? rows.slice(0, MAX_LOCATIONS) : rows).map((row) =>
    toScope(
      {
        id: row.environmentId,
        slug: row.environmentSlug,
        type: row.environmentType as RuntimeEnvironmentType,
        branchName: row.environmentBranchName,
        organizationId: row.environmentOrganizationId,
        project: { externalRef: row.projectExternalRef },
      },
      { queueName: row.name, queueType: row.name.startsWith(TASK_QUEUE_PREFIX) ? "task" : "custom" }
    )
  );

  return {
    found: true,
    kind: "queue",
    id: name,
    scopes,
    ...(truncated ? { truncated: true } : {}),
  };
}

// Resolves anywhere in the actor's organization, instead of sweeping each project.
export async function locateAgentObject(
  kind: "run" | "deployment" | "error" | "queue",
  id: string,
  actor: AuthenticatedOrgActor,
  opts?: { maxExcludedDevEnvironments?: number; maxVisibleEnvironments?: number }
): Promise<LocateResult> {
  switch (kind) {
    case "run":
      return locateRun(id, actor);
    case "deployment":
      return locateDeployment(id, actor);
    case "error":
      return locateError(id, actor, opts?.maxExcludedDevEnvironments);
    case "queue":
      return locateQueue(id, actor, opts?.maxVisibleEnvironments);
  }
}
