import type { Prisma } from "@trigger.dev/database";

/**
 * Where-clause for resolving a dependent/parent TaskRunAttempt by friendlyId,
 * scoped to the caller's environment via the related run. The env scope keeps a
 * foreign friendlyId from resolving onto the new batch. Standalone builder so
 * the scope can be asserted directly in tests.
 */
export function dependentAttemptWhere(
  friendlyId: string,
  environmentId: string
): Prisma.TaskRunAttemptWhereInput {
  return {
    friendlyId,
    taskRun: { runtimeEnvironmentId: environmentId },
  };
}
