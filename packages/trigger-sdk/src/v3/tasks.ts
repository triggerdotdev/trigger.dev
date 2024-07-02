import { InitOutput } from "@trigger.dev/core/v3";
import { batchTrigger, createTask, trigger, triggerAndPoll } from "./shared";

import type {
  TaskOptions,
  Task,
  Queue,
  RunHandle,
  BatchRunHandle,
  TaskRunResult,
  BatchResult,
  BatchItem,
  TaskPayload,
  TaskOutput,
  TaskIdentifier,
  TaskRunOptions,
} from "./shared";

export type {
  TaskOptions,
  Task,
  Queue,
  RunHandle,
  BatchRunHandle,
  TaskRunResult,
  BatchResult,
  BatchItem,
  TaskPayload,
  TaskOutput,
  TaskIdentifier,
  TaskRunOptions,
};

/** Creates a task that can be triggered
 * @param options - Task options
 * @example 
 * 
 * ```ts
 * import { task } from "@trigger.dev/sdk/v3";
 *
 * export const helloWorld = task({
    id: "hello-world",
 *    run: async (payload: { url: string }) => {
 *    return { hello: "world" };
 *  },
 * });
 *
 * ```
 * 
 * @returns A task that can be triggered
 */
export function task<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  options: TaskOptions<TIdentifier, TInput, TOutput, TInitOutput>
): Task<TIdentifier, TInput, TOutput> {
  return createTask<TIdentifier, TInput, TOutput, TInitOutput>(options);
}

export const tasks = {
  trigger,
  triggerAndPoll,
  batchTrigger,
};
