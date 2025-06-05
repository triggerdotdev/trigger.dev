"use client";

import {
  type AnyTask,
  type TaskIdentifier,
  type TaskPayload,
  InferRunTypes,
  makeIdempotencyKey,
  RunHandleFromTypes,
  stringifyIO,
  type TriggerOptions,
  type RealtimeRunSkipColumns,
} from "@trigger.dev/core/v3";
import useSWRMutation from "swr/mutation";
import { useApiClient, UseApiClientOptions } from "./useApiClient.js";
import {
  useRealtimeRun,
  UseRealtimeRunInstance,
  useRealtimeRunWithStreams,
  UseRealtimeRunWithStreamsInstance,
} from "./useRealtime.js";

/**
 * Base interface for task trigger instances.
 *
 * @template TTask - The type of the task
 */
export interface TriggerInstance<TTask extends AnyTask> {
  /** Function to submit the task with a payload */
  submit: (payload: TaskPayload<TTask>, options?: TriggerOptions) => void;
  /** Whether the task is currently being submitted */
  isLoading: boolean;
  /** The handle returned after successful task submission */
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
  /** Any error that occurred during submission */
  error?: Error;
}

export type UseTaskTriggerOptions = UseApiClientOptions;

/**
 * Hook to trigger a task and manage its initial execution state.
 *
 * @template TTask - The type of the task
 * @param {TaskIdentifier<TTask>} id - The identifier of the task to trigger
 * @param {UseTaskTriggerOptions} [options] - Configuration options for the task trigger
 * @returns {TriggerInstance<TTask>} An object containing the submit function, loading state, handle, and any errors
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { submit, isLoading, handle, error } = useTaskTrigger<typeof myTask>('my-task-id');
 *
 * // Submit the task with payload
 * submit({ foo: 'bar' });
 * ```
 */
export function useTaskTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  options?: UseTaskTriggerOptions
): TriggerInstance<TTask> {
  const apiClient = useApiClient(options);

  async function triggerTask(
    id: string,
    {
      arg: { payload, options },
    }: { arg: { payload: TaskPayload<TTask>; options?: TriggerOptions } }
  ) {
    if (!apiClient) {
      throw new Error("Could not trigger task in useTaskTrigger: Missing access token");
    }

    const payloadPacket = await stringifyIO(payload);

    const handle = await apiClient.triggerTask(id, {
      payload: payloadPacket.data,
      options: {
        queue: options?.queue ? { name: options.queue } : undefined,
        concurrencyKey: options?.concurrencyKey,
        payloadType: payloadPacket.dataType,
        idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
        delay: options?.delay,
        ttl: options?.ttl,
        tags: options?.tags,
        maxAttempts: options?.maxAttempts,
        metadata: options?.metadata,
        maxDuration: options?.maxDuration,
        lockToVersion: options?.version,
      },
    });

    return { ...handle, taskIdentifier: id };
  }

  const mutation = useSWRMutation(id as string, triggerTask);

  return {
    submit: (payload, options) => {
      // trigger the task with the given payload
      mutation.trigger({ payload, options });
    },
    isLoading: mutation.isMutating,
    handle: mutation.data as RunHandleFromTypes<InferRunTypes<TTask>>,
    error: mutation.error,
  };
}

/**
 * Configuration options for task triggers with realtime updates.
 */
export type UseRealtimeTaskTriggerOptions = UseTaskTriggerOptions & {
  /** Whether the realtime subscription is enabled */
  enabled?: boolean;
  /** Optional throttle time in milliseconds for stream updates */
  experimental_throttleInMs?: number;

  /**
   * Skip columns from the subscription.
   *
   * @default []
   */
  skipColumns?: RealtimeRunSkipColumns;
};

export type RealtimeTriggerInstanceWithStreams<
  TTask extends AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
> = UseRealtimeRunWithStreamsInstance<TTask, TStreams> & {
  submit: (payload: TaskPayload<TTask>, options?: TriggerOptions) => void;
  isLoading: boolean;
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
};

/**
 * Hook to trigger a task and subscribe to its realtime updates including stream data.
 *
 * @template TTask - The type of the task
 * @template TStreams - The type of the streams data
 * @param {TaskIdentifier<TTask>} id - The identifier of the task to trigger
 * @param {UseRealtimeTaskTriggerOptions} [options] - Configuration options for the task trigger and realtime updates
 * @returns {RealtimeTriggerInstanceWithStreams<TTask, TStreams>} An object containing the submit function, loading state,
 *          handle, run state, streams data, and error handling
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { submit, run, streams, error } = useRealtimeTaskTriggerWithStreams<
 *   typeof myTask,
 *   { output: string }
 * >('my-task-id');
 *
 * // Submit and monitor the task with streams
 * submit({ foo: 'bar' });
 * ```
 */
export function useRealtimeTaskTriggerWithStreams<
  TTask extends AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
>(
  id: TaskIdentifier<TTask>,
  options?: UseRealtimeTaskTriggerOptions
): RealtimeTriggerInstanceWithStreams<TTask, TStreams> {
  const triggerInstance = useTaskTrigger<TTask>(id, options);
  const realtimeInstance = useRealtimeRunWithStreams<TTask, TStreams>(triggerInstance.handle?.id, {
    ...options,
    id: triggerInstance.handle?.id,
    accessToken: triggerInstance.handle?.publicAccessToken ?? options?.accessToken,
  });

  return {
    ...realtimeInstance,
    ...triggerInstance,
  };
}

export type RealtimeTriggerInstance<TTask extends AnyTask> = UseRealtimeRunInstance<TTask> & {
  submit: (payload: TaskPayload<TTask>, options?: TriggerOptions) => void;
  isLoading: boolean;
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
};

/**
 * Hook to trigger a task and subscribe to its realtime updates.
 *
 * @template TTask - The type of the task
 * @param {TaskIdentifier<TTask>} id - The identifier of the task to trigger
 * @param {UseRealtimeTaskTriggerOptions} [options] - Configuration options for the task trigger and realtime updates
 * @returns {RealtimeTriggerInstance<TTask>} An object containing the submit function, loading state,
 *          handle, run state, and error handling
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { submit, run, error, stop } = useRealtimeTaskTrigger<typeof myTask>('my-task-id');
 *
 * // Submit and monitor the task
 * submit({ foo: 'bar' });
 *
 * // Stop monitoring when needed
 * stop();
 * ```
 */

export function useRealtimeTaskTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  options?: UseRealtimeTaskTriggerOptions
): RealtimeTriggerInstance<TTask> {
  const triggerInstance = useTaskTrigger<TTask>(id, options);
  const realtimeInstance = useRealtimeRun<TTask>(triggerInstance.handle?.id, {
    ...options,
    id: triggerInstance.handle?.id,
    accessToken: triggerInstance.handle?.publicAccessToken ?? options?.accessToken,
  });

  return {
    submit: triggerInstance.submit,
    isLoading: triggerInstance.isLoading,
    handle: triggerInstance.handle,
    run: realtimeInstance.run,
    error: realtimeInstance.error ?? triggerInstance.error,
    stop: realtimeInstance.stop,
  };
}
