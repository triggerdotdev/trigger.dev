/**
 * Features in preview. Their API can change between minor releases, and they need to be enabled
 * for your organization.
 */
import type { InitOutput, PreviewTaskOptions, TaskSchema } from "@trigger.dev/core/v3";
import type { ScheduleOptions } from "./schedules/index.js";
import * as rootSchedules from "./schedules/index.js";
import type {
  Task,
  TaskOptions,
  TaskOptionsWithSchema,
  TaskWithSchema,
  TaskWithSchemaOptions,
} from "./shared.js";
import { createSchemaTask, createTask } from "./shared.js";

export { defineMachine, type NamedMachine } from "./machines.js";
export type { PreviewTaskOptions };

/** Task options with the ones in preview, which widen `machine` and add `sandbox`. */
type WithPreviewOptions<TOptions> = Omit<TOptions, "machine"> & PreviewTaskOptions;

// The task functions index every option in preview; only their public types leave them out.

/** `task()` with the options in preview: `sandbox`, and a `defineMachine()` machine. */
export function task<
  TIdentifier extends string,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: WithPreviewOptions<TaskOptionsWithSchema<TIdentifier, TOutput, TInitOutput>>
): Task<TIdentifier, any, TOutput>;
export function task<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: WithPreviewOptions<TaskOptions<TIdentifier, TInput, TOutput, TInitOutput>>
): Task<TIdentifier, TInput, TOutput>;
export function task(params: WithPreviewOptions<TaskOptions<string, any>>) {
  return createTask(params as TaskOptions<string, any>);
}

/** `schemaTask()` with the options in preview: `sandbox`, and a `defineMachine()` machine. */
export function schemaTask<
  TIdentifier extends string,
  TSchema extends TaskSchema | undefined = undefined,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: WithPreviewOptions<TaskWithSchemaOptions<TIdentifier, TSchema, TOutput, TInitOutput>>
): TaskWithSchema<TIdentifier, TSchema, TOutput> {
  return createSchemaTask(
    params as TaskWithSchemaOptions<TIdentifier, TSchema, TOutput, TInitOutput>
  );
}

/**
 * The `schedules` API, whose `task()` takes the options in preview: `sandbox`, and a
 * `defineMachine()` machine.
 */
export const schedules = {
  ...rootSchedules,
  task<
    TIdentifier extends string,
    TOutput,
    TInitOutput extends InitOutput,
    const TWindow extends string | undefined = undefined,
  >(params: WithPreviewOptions<ScheduleOptions<TIdentifier, TOutput, TInitOutput, TWindow>>) {
    return rootSchedules.task(
      params as ScheduleOptions<TIdentifier, TOutput, TInitOutput, TWindow>
    );
  },
};
