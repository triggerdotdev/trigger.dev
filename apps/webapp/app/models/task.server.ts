import type { Task, TaskAttempt } from "@trigger.dev/database";
import { ServerTask } from "@trigger.dev/internal";

export type TaskWithAttempts = Task & { attempts: TaskAttempt[] };

export function taskWithAttemptsToServerTask(
  task: TaskWithAttempts
): ServerTask {
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
