/**
 * `TaskQueue.name` as the engine and the watch checks store it. A task queue keeps its
 * `task/` prefix there, and the presenters strip it for display only.
 */
export function storedQueueName(queue: { type: string; name: string }): string {
  return queue.type === "task" ? `task/${queue.name.replace(/^(?:task\/)+/, "")}` : queue.name;
}
