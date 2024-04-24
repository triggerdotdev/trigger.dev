import { InitOutput } from "@trigger.dev/core/v3";
import { TaskOptions, Task, createTask } from "./shared";

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
export function task<TInput = void, TOutput = unknown, TInitOutput extends InitOutput = any>(
  options: TaskOptions<TInput, TOutput, TInitOutput>
): Task<TInput, TOutput> {
  return createTask<TInput, TOutput, TInitOutput>(options);
}

export type { TaskOptions, Task };
