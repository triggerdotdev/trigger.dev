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
import { useApiClient } from "./useApiClient.js";

export interface TriggerInstance<TTask extends AnyTask> {
  submit: (payload: TaskPayload<TTask>) => void;
  isLoading: boolean;
  handle?: RunHandleFromTypes<InferRunTypes<TTask>>;
}

export function useTaskTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>
): TriggerInstance<TTask> {
  const apiClient = useApiClient();

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
