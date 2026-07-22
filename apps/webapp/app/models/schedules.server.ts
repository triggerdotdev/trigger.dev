import type { Prisma, PrismaClientOrTransaction, TaskSchedule } from "@trigger.dev/database";

export function scheduleUniqWhereClause(
  projectId: string,
  scheduleId: string
): Prisma.TaskScheduleWhereUniqueInput {
  if (scheduleId.startsWith("sched_")) {
    return {
      friendlyId: scheduleId,
      projectId,
    };
  }

  return {
    projectId_deduplicationKey: {
      projectId,
      deduplicationKey: scheduleId,
    },
  };
}

export function scheduleWhereClause(
  projectId: string,
  scheduleId: string
): Prisma.TaskScheduleWhereInput {
  if (scheduleId.startsWith("sched_")) {
    return {
      friendlyId: scheduleId,
      projectId,
    };
  }

  return {
    projectId,
    deduplicationKey: scheduleId,
  };
}

/**
 * Resolve a schedule's visibility for an environment-scoped caller.
 *
 *   - "visible": the schedule exists in the project and has at least one
 *     instance bound to `environmentId` (or has no instances yet).
 *   - "hidden": the schedule exists but none of its instances live in the
 *     caller's environment.
 *   - "missing": no schedule exists for the (project, scheduleId) pair.
 *
 * A schedule can be bound to several environments at once, so visibility
 * mirrors the "some instance is in this environment" rule the schedule
 * list uses: a schedule that is listed for a key must also be readable
 * and mutable by that key. This still rejects cross-environment access to
 * schedules the caller has no instance in, and `scheduleWhereClause`
 * already confines the lookup to the caller's project.
 *
 * The tri-state lets PUT (upsert) disambiguate "hidden" (refuse) from
 * "missing" (fall through to create). DELETE/GET treat hidden and
 * missing the same way.
 */
export type ScheduleEnvVisibility =
  | { status: "visible"; schedule: TaskSchedule }
  | { status: "hidden" }
  | { status: "missing" };

export async function getScheduleEnvVisibility(
  prisma: PrismaClientOrTransaction,
  projectId: string,
  scheduleId: string,
  environmentId: string
): Promise<ScheduleEnvVisibility> {
  const schedule = await prisma.taskSchedule.findFirst({
    where: scheduleWhereClause(projectId, scheduleId),
    include: { instances: { select: { environmentId: true } } },
  });

  if (!schedule) return { status: "missing" };

  const { instances, ...rest } = schedule;
  if (instances.length === 0) return { status: "visible", schedule: rest };
  const scoped = instances.some((i) => i.environmentId === environmentId);
  if (!scoped) return { status: "hidden" };
  return { status: "visible", schedule: rest };
}
