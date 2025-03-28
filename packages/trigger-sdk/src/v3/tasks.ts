import {
  onStart,
  onFailure,
  onSuccess,
  onComplete,
  onWait,
  onResume,
  onHandleError,
  onCatchError,
  middleware,
} from "./hooks.js";
import {
  batchTrigger,
  batchTriggerAndWait,
  createTask,
  createSchemaTask,
  createToolTask,
  SubtaskUnwrapError,
  trigger,
  triggerAndPoll,
  triggerAndWait,
} from "./shared.js";

export { SubtaskUnwrapError };

import type {
  AnyTask,
  BatchItem,
  BatchResult,
  BatchRunHandle,
  Queue,
  RunHandle,
  Task,
  TaskIdentifier,
  TaskOptions,
  TaskOutput,
  TaskPayload,
  TriggerOptions,
  TaskRunResult,
  TaskFromIdentifier,
} from "./shared.js";

export type {
  AnyTask,
  BatchItem,
  BatchResult,
  BatchRunHandle,
  Queue,
  RunHandle,
  Task,
  TaskIdentifier,
  TaskOptions,
  TaskOutput,
  TaskPayload,
  TriggerOptions,
  TaskRunResult,
  TaskFromIdentifier,
};

export type * from "./hooks.js";

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
export const task = createTask;

export const schemaTask = createSchemaTask;

export const toolTask = createToolTask;

export const tasks = {
  trigger,
  triggerAndPoll,
  batchTrigger,
  triggerAndWait,
  batchTriggerAndWait,
  onStart,
  onFailure,
  onSuccess,
  onComplete,
  onWait,
  onResume,
  /** @deprecated Use catchError instead */
  handleError: onHandleError,
  catchError: onCatchError,
  middleware,
};
