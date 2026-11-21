import { Prisma, type WorkerDeploymentStatus } from "@trigger.dev/database";
import type { DeploymentDisplayStatus } from "~/components/runs/v3/DeploymentStatus";

type StoredFilterStatus = Exclude<WorkerDeploymentStatus, "CANCELED">;

// Every stored status except CANCELED (handled with SUPERSEDED below). Typed as a Record so a new
// enum value fails the typecheck until it's added here.
const storedFilterStatuses: Record<StoredFilterStatus, true> = {
  PENDING: true,
  INSTALLING: true,
  BUILDING: true,
  DEPLOYING: true,
  DEPLOYED: true,
  FAILED: true,
  TIMED_OUT: true,
};

function isStoredFilterStatus(status: string): status is StoredFilterStatus {
  return Object.hasOwn(storedFilterStatuses, status);
}

/**
 * The deployments list's Status filter, as an `AND (...)` clause on `wd`.
 *
 * The statuses are written into the SQL as enum literals, not bound as a parameter: a bound
 * `ANY(CAST($1 AS "WorkerDeploymentStatus"[]))` hides the values from the planner, which then
 * reads every deployment in the environment instead of using `(environmentId, status, id)`.
 * Only names from the allowlist above reach the SQL.
 *
 * "Superseded" isn't a stored status: it's a canceled deployment that a newer one replaced. So
 * "Canceled" matches only the canceled deployments nothing replaced.
 */
export function deploymentStatusFilterSql(statuses: DeploymentDisplayStatus[]): Prisma.Sql {
  const stored = [...new Set(statuses)].filter(isStoredFilterStatus);

  const conditions: Prisma.Sql[] = [];
  if (stored.length > 0) {
    conditions.push(
      Prisma.sql`wd."status" IN (${Prisma.raw(stored.map((status) => `'${status}'`).join(", "))})`
    );
  }
  if (statuses.includes("CANCELED")) {
    conditions.push(Prisma.sql`(wd."status" = 'CANCELED' AND wd."supersededById" IS NULL)`);
  }
  if (statuses.includes("SUPERSEDED")) {
    conditions.push(Prisma.sql`(wd."status" = 'CANCELED' AND wd."supersededById" IS NOT NULL)`);
  }

  if (conditions.length === 0) {
    return Prisma.sql`AND FALSE`;
  }

  return Prisma.sql`AND (${Prisma.join(conditions, " OR ")})`;
}
