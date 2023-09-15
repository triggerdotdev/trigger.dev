import type { Task, TaskAttempt } from "@trigger.dev/database";
import { ServerTask } from "@trigger.dev/core";
import { PrismaClientOrTransaction } from "~/db.server";

export type TaskWithAttempts = Task & { attempts: TaskAttempt[] };

export function taskWithAttemptsToServerTask(task: TaskWithAttempts): ServerTask {
  return {
    id: task.id,
    name: task.name,
    icon: task.icon,
    noop: task.noop,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    delayUntil: task.delayUntil,
    status: task.status,
    description: task.description,
    params: task.params as any,
    output: task.output as any,
    properties: task.properties as any,
    style: task.style as any,
    error: task.error,
    parentId: task.parentId,
    attempts: task.attempts.length,
    idempotencyKey: task.idempotencyKey,
    operation: task.operation,
  };
}

export type KitchenSinkTask = NonNullable<Awaited<ReturnType<typeof findKitchenSinkTask>>>;

export async function findKitchenSinkTask(prisma: PrismaClientOrTransaction, id: string) {
  return prisma.task.findUnique({
    where: { id },
    include: {
      attempts: true,
      run: {
        include: {
          environment: true,
          queue: true,
        },
      },
    },
  });
}
