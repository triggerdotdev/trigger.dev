import { PrismaClientOrTransaction, Waitpoint } from "@trigger.dev/database";
import { nanoid } from "nanoid";

export async function createRunAssociatedWaitpoint(
  prisma: PrismaClientOrTransaction,
  { projectId, completedByTaskRunId }: { projectId: string; completedByTaskRunId: string }
) {
  return prisma.waitpoint.create({
    data: {
      type: "RUN",
      status: "PENDING",
      idempotencyKey: nanoid(24),
      userProvidedIdempotencyKey: false,
      projectId,
      completedByTaskRunId,
    },
  });
}

export async function createDateTimeWaitpoint(
  prisma: PrismaClientOrTransaction,
  { projectId, completedAfter }: { projectId: string; completedAfter: Date }
) {
  return prisma.waitpoint.create({
    data: {
      type: "DATETIME",
      status: "PENDING",
      idempotencyKey: nanoid(24),
      userProvidedIdempotencyKey: false,
      projectId,
      completedAfter,
    },
  });
}

export async function blockRunWithWaitpoint(
  prisma: PrismaClientOrTransaction,
  { runId, waitpoint }: { runId: string; waitpoint: Waitpoint }
) {
  return prisma.taskRunWaitpoint.create({
    data: {
      taskRunId: runId,
      waitpointId: waitpoint.id,
      projectId: waitpoint.projectId,
    },
  });
}

/** Any runs blocked by this waitpoint will get continued (if no other waitpoints exist) */
export function completeWaitpoint(id: string) {}
