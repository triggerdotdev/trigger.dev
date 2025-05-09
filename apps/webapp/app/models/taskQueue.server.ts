import { QueueManifest } from "@trigger.dev/core/v3/schemas";
import { TaskQueue } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export async function findQueueInEnvironment(
  queueName: string,
  environmentId: string,
  backgroundWorkerTaskId?: string,
  backgroundTask?: { queueConfig?: unknown }
): Promise<TaskQueue | undefined> {
  const sanitizedQueueName = sanitizeQueueName(queueName);

  const queue = await prisma.taskQueue.findFirst({
    where: {
      runtimeEnvironmentId: environmentId,
      name: sanitizedQueueName,
    },
  });

  if (queue) {
    return queue;
  }

  const task = backgroundTask
    ? backgroundTask
    : backgroundWorkerTaskId
    ? await prisma.backgroundWorkerTask.findFirst({
        where: {
          id: backgroundWorkerTaskId,
        },
      })
    : undefined;

  if (!task) {
    return;
  }

  const queueConfig = QueueManifest.safeParse(task.queueConfig);

  if (queueConfig.success) {
    const taskQueueName = queueConfig.data.name
      ? sanitizeQueueName(queueConfig.data.name)
      : undefined;

    if (taskQueueName && taskQueueName !== sanitizedQueueName) {
      const queue = await prisma.taskQueue.findFirst({
        where: {
          runtimeEnvironmentId: environmentId,
          name: taskQueueName,
        },
      });

      if (queue) {
        return queue;
      }
    }
  }
}

// Only allow alphanumeric characters, underscores, hyphens, and slashes (and only the first 128 characters)
export function sanitizeQueueName(queueName: string) {
  return queueName.replace(/[^a-zA-Z0-9_\-\/]/g, "").substring(0, 128);
}
