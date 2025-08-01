import { Prisma } from "~/db.server";

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
