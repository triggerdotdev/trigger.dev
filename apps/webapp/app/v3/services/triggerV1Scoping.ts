import type { Prisma } from "@trigger.dev/database";

// Where-clauses for resolving caller-supplied parent/dependent attempt & batch
// friendlyIds in the V1 trigger path, scoped to the caller's environment so a
// foreign friendlyId can't be wired onto the new run/batch. Standalone builders
// so the scope can be asserted directly in tests.

export function attemptInEnvironmentWhere(
  friendlyId: string,
  environmentId: string
): Prisma.TaskRunAttemptWhereInput {
  return { friendlyId, taskRun: { runtimeEnvironmentId: environmentId } };
}

export function batchRunInEnvironmentWhere(
  friendlyId: string,
  environmentId: string
): Prisma.BatchTaskRunWhereInput {
  return { friendlyId, runtimeEnvironmentId: environmentId };
}
