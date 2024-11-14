"use client";

import {
  type AnyTask,
  type TaskIdentifier,
  type TaskPayload,
  InferRunTypes,
  makeIdempotencyKey,
  RunHandleFromTypes,
  stringifyIO,
  TaskRunOptions,
} from "@trigger.dev/core/v3";
import useSWRMutation from "swr/mutation";
import { useApiClient, UseApiClientOptions } from "./useApiClient.js";
import {
  useRealtimeRun,
  UseRealtimeRunInstance,
  useRealtimeRunWithStreams,
  UseRealtimeRunWithStreamsInstance,
} from "./useRealtime.js";

export interface TriggerInstance<TTask extends AnyTask> {
  submit: (payload: TaskPayload<TTask>) => void;
  isLoading: boolean;
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
}

export type UseTaskTriggerOptions = UseApiClientOptions;

export function useTaskTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  options?: UseTaskTriggerOptions
): TriggerInstance<TTask> {
  const apiClient = useApiClient(options);

  async function triggerTask(
    id: string,
    {
      arg: { payload, options },
    }: { arg: { payload: TaskPayload<TTask>; options?: TaskRunOptions } }
  ) {
    const payloadPacket = await stringifyIO(payload);

    const handle = await apiClient.triggerTask(id, {
      payload: payloadPacket.data,
      options: {
        queue: options?.queue,
        concurrencyKey: options?.concurrencyKey,
        payloadType: payloadPacket.dataType,
        idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
        delay: options?.delay,
        ttl: options?.ttl,
        tags: options?.tags,
        maxAttempts: options?.maxAttempts,
        metadata: options?.metadata,
        maxDuration: options?.maxDuration,
      },
    });

    return { ...handle, taskIdentifier: id };
  }

  const mutation = useSWRMutation(id as string, triggerTask);

  return {
    submit: (payload) => {
      // trigger the task with the given payload
      mutation.trigger({ payload });
    },
    isLoading: mutation.isMutating,
    handle: mutation.data as RunHandleFromTypes<InferRunTypes<TTask>>,
  };
}

export type UseRealtimeTaskTriggerOptions = UseTaskTriggerOptions & {
  enabled?: boolean;
  experimental_throttleInMs?: number;
};

export type RealtimeTriggerInstanceWithStreams<
  TTask extends AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
> = UseRealtimeRunWithStreamsInstance<TTask, TStreams> & {
  submit: (payload: TaskPayload<TTask>) => void;
  isLoading: boolean;
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
};

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
  submit: (payload: TaskPayload<TTask>) => void;
  isLoading: boolean;
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
};

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
    ...realtimeInstance,
    ...triggerInstance,
  };
}
