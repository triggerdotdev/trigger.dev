import type { Task, TaskAttempt } from "@trigger.dev/database";
import { CachedTask, ServerTask } from "@trigger.dev/core";

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
    callbackUrl: task.callbackUrl,
  };
}

export type TaskForCaching = Pick<
  Task,
  "id" | "status" | "idempotencyKey" | "noop" | "output" | "parentId"
>;

export function prepareTasksForCaching(
  possibleTasks: TaskForCaching[],
  maxSize: number
): {
  tasks: CachedTask[];
  cursor: string | undefined;
} {
  const tasks = possibleTasks.filter((task) => task.status === "COMPLETED" && !task.noop);

  // Select tasks using greedy approach
  const tasksToRun: CachedTask[] = [];
  let remainingSize = maxSize;

  for (const task of tasks) {
    const cachedTask = prepareTaskForCaching(task);
    const size = calculateCachedTaskSize(cachedTask);

    if (size <= remainingSize) {
      tasksToRun.push(cachedTask);
      remainingSize -= size;
    }
  }

  return {
    tasks: tasksToRun,
    cursor: tasks.length > tasksToRun.length ? tasks[tasksToRun.length].id : undefined,
  };
}

export function prepareTasksForCachingLegacy(
  possibleTasks: TaskForCaching[],
  maxSize: number
): {
  tasks: CachedTask[];
  cursor: string | undefined;
} {
  const tasks = possibleTasks.filter((task) => task.status === "COMPLETED");

  // Prepare tasks and calculate their sizes
  const availableTasks = tasks.map((task) => {
    const cachedTask = prepareTaskForCaching(task);
    return { task: cachedTask, size: calculateCachedTaskSize(cachedTask) };
  });

  // Sort tasks in ascending order by size
  availableTasks.sort((a, b) => a.size - b.size);

  // Select tasks using greedy approach
  const tasksToRun: CachedTask[] = [];
  let remainingSize = maxSize;

  for (const { task, size } of availableTasks) {
    if (size <= remainingSize) {
      tasksToRun.push(task);
      remainingSize -= size;
    }
  }

  return {
    tasks: tasksToRun,
    cursor: undefined,
  };
}

function prepareTaskForCaching(task: TaskForCaching): CachedTask {
  return {
    id: task.idempotencyKey, // We should eventually move this back to task.id
    status: task.status,
    idempotencyKey: task.idempotencyKey,
    noop: task.noop,
    output: task.output as any,
    parentId: task.parentId,
  };
}

function calculateCachedTaskSize(task: CachedTask): number {
  return JSON.stringify(task).length;
}
