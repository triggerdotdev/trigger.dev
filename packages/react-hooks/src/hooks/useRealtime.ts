"use client";

import { AnyTask, ApiClient, InferRunTypes, RealtimeRun } from "@trigger.dev/core/v3";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { KeyedMutator, useSWR } from "../utils/trigger-swr.js";
import { useApiClient, UseApiClientOptions } from "./useApiClient.js";
import { createThrottledQueue } from "../utils/throttle.js";

export type UseRealtimeRunOptions = UseApiClientOptions & {
  id?: string;
  enabled?: boolean;
  experimental_throttleInMs?: number;
};

export type UseRealtimeSingleRunOptions<TTask extends AnyTask = AnyTask> = UseRealtimeRunOptions & {
  /**
   * Callback this is called when the run completes, an error occurs, or the subscription is stopped.
   *
   * @param {RealtimeRun<TTask>} run - The run object
   * @param {Error} [err] - The error that occurred
   */
  onComplete?: (run: RealtimeRun<TTask>, err?: Error) => void;

  /**
   * Whether to stop the subscription when the run completes
   *
   * @default true
   *
   * Set this to false if you are making updates to the run metadata after completion through child runs
   */
  stopOnCompletion?: boolean;
};

export type UseRealtimeRunInstance<TTask extends AnyTask = AnyTask> = {
  run: RealtimeRun<TTask> | undefined;

  error: Error | undefined;

  /**
   * Abort the current request immediately.
   */
  stop: () => void;
};

/**
 * Hook to subscribe to realtime updates of a task run.
 *
 * @template TTask - The type of the task
 * @param {string} [runId] - The unique identifier of the run to subscribe to
 * @param {UseRealtimeSingleRunOptions} [options] - Configuration options for the subscription
 * @returns {UseRealtimeRunInstance<TTask>} An object containing the current state of the run, error handling, and control methods
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { run, error } = useRealtimeRun<typeof myTask>('run-id-123');
 * ```
 */

export function useRealtimeRun<TTask extends AnyTask>(
  runId?: string,
  options?: UseRealtimeSingleRunOptions<TTask>
): UseRealtimeRunInstance<TTask> {
  const hookId = useId();
  const idKey = options?.id ?? hookId;

  // Store the streams state in SWR, using the idKey as the key to share states.
  const { data: run, mutate: mutateRun } = useSWR<RealtimeRun<TTask>>([idKey, "run"], null);

  const { data: error = undefined, mutate: setError } = useSWR<undefined | Error>(
    [idKey, "error"],
    null
  );

  // Add state to track when the subscription is complete
  const { data: isComplete = false, mutate: setIsComplete } = useSWR<boolean>(
    [idKey, "complete"],
    null
  );

  // Abort controller to cancel the current API call.
  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const apiClient = useApiClient(options);

  const triggerRequest = useCallback(async () => {
    try {
      if (!runId || !apiClient) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeRun(
        runId,
        apiClient,
        mutateRun,
        setError,
        abortControllerRef,
        typeof options?.stopOnCompletion === "boolean" ? options.stopOnCompletion : true
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }

      // Mark the subscription as complete
      setIsComplete(true);
    }
  }, [runId, mutateRun, abortControllerRef, apiClient, setError]);

  const hasCalledOnCompleteRef = useRef(false);

  // Effect to handle onComplete callback
  useEffect(() => {
    if (isComplete && run && options?.onComplete && !hasCalledOnCompleteRef.current) {
      options.onComplete(run, error);
      hasCalledOnCompleteRef.current = true;
    }
  }, [isComplete, run, error, options?.onComplete]);

  useEffect(() => {
    if (typeof options?.enabled === "boolean" && !options.enabled) {
      return;
    }

    if (!runId) {
      return;
    }

    triggerRequest().finally(() => {});

    return () => {
      stop();
    };
  }, [runId, stop, options?.enabled]);

  useEffect(() => {
    if (run?.finishedAt) {
      setIsComplete(true);
    }
  }, [run]);

  return { run, error, stop };
}

export type StreamResults<TStreams extends Record<string, any>> = {
  [K in keyof TStreams]: Array<TStreams[K]>;
};

export type UseRealtimeRunWithStreamsInstance<
  TTask extends AnyTask = AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
> = {
  run: RealtimeRun<TTask> | undefined;

  streams: StreamResults<TStreams>;

  error: Error | undefined;

  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void;
};

/**
 * Hook to subscribe to realtime updates of a task run with associated data streams.
 *
 * @template TTask - The type of the task
 * @template TStreams - The type of the streams data
 * @param {string} [runId] - The unique identifier of the run to subscribe to
 * @param {UseRealtimeRunOptions} [options] - Configuration options for the subscription
 * @returns {UseRealtimeRunWithStreamsInstance<TTask, TStreams>} An object containing the current state of the run, streams data, and error handling
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { run, streams, error } = useRealtimeRunWithStreams<typeof myTask, {
 *   output: string;
 * }>('run-id-123');
 * ```
 */
export function useRealtimeRunWithStreams<
  TTask extends AnyTask = AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
>(
  runId?: string,
  options?: UseRealtimeSingleRunOptions<TTask>
): UseRealtimeRunWithStreamsInstance<TTask, TStreams> {
  const hookId = useId();
  const idKey = options?.id ?? hookId;

  const [initialStreamsFallback] = useState({} as StreamResults<TStreams>);

  // Store the streams state in SWR, using the idKey as the key to share states.
  const { data: streams, mutate: mutateStreams } = useSWR<StreamResults<TStreams>>(
    [idKey, "streams"],
    null,
    {
      fallbackData: initialStreamsFallback,
    }
  );

  // Keep the latest streams in a ref.
  const streamsRef = useRef<StreamResults<TStreams>>(streams ?? ({} as StreamResults<TStreams>));
  useEffect(() => {
    streamsRef.current = streams || ({} as StreamResults<TStreams>);
  }, [streams]);

  // Store the streams state in SWR, using the idKey as the key to share states.
  const { data: run, mutate: mutateRun } = useSWR<RealtimeRun<TTask>>([idKey, "run"], null);

  // Add state to track when the subscription is complete
  const { data: isComplete = false, mutate: setIsComplete } = useSWR<boolean>(
    [idKey, "complete"],
    null
  );

  const { data: error = undefined, mutate: setError } = useSWR<undefined | Error>(
    [idKey, "error"],
    null
  );

  // Abort controller to cancel the current API call.
  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const apiClient = useApiClient(options);

  const triggerRequest = useCallback(async () => {
    try {
      if (!runId || !apiClient) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeRunWithStreams(
        runId,
        apiClient,
        mutateRun,
        mutateStreams,
        streamsRef,
        setError,
        abortControllerRef,
        typeof options?.stopOnCompletion === "boolean" ? options.stopOnCompletion : true,
        options?.experimental_throttleInMs
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }

      // Mark the subscription as complete
      setIsComplete(true);
    }
  }, [runId, mutateRun, mutateStreams, streamsRef, abortControllerRef, apiClient, setError]);

  const hasCalledOnCompleteRef = useRef(false);

  // Effect to handle onComplete callback
  useEffect(() => {
    if (isComplete && run && options?.onComplete && !hasCalledOnCompleteRef.current) {
      options.onComplete(run, error);
      hasCalledOnCompleteRef.current = true;
    }
  }, [isComplete, run, error, options?.onComplete]);

  useEffect(() => {
    if (typeof options?.enabled === "boolean" && !options.enabled) {
      return;
    }

    if (!runId) {
      return;
    }

    triggerRequest().finally(() => {});

    return () => {
      stop();
    };
  }, [runId, stop, options?.enabled]);

  useEffect(() => {
    if (run?.finishedAt) {
      setIsComplete(true);
    }
  }, [run]);

  return { run, streams: streams ?? initialStreamsFallback, error, stop };
}

export type UseRealtimeRunsInstance<TTask extends AnyTask = AnyTask> = {
  runs: RealtimeRun<TTask>[];

  error: Error | undefined;

  /**
   * Abort the current request immediately.
   */
  stop: () => void;
};

export type UseRealtimeRunsWithTagOptions = UseRealtimeRunOptions & {
  /**
   * Filter runs by the time they were created. You must specify the duration string like "1h", "10s", "30m", etc.
   *
   * @example
   * "1h" - 1 hour ago
   * "10s" - 10 seconds ago
   * "30m" - 30 minutes ago
   * "1d" - 1 day ago
   * "1w" - 1 week ago
   *
   * The maximum duration is 1 week
   *
   * @note The timestamp will be calculated on the server side when you first subscribe to the runs.
   *
   */
  createdAt?: string;
};

/**
 * Hook to subscribe to realtime updates of task runs filtered by tag(s).
 *
 * @template TTask - The type of the task
 * @param {string | string[]} tag - The tag or array of tags to filter runs by
 * @param {UseRealtimeRunOptions} [options] - Configuration options for the subscription
 * @returns {UseRealtimeRunsInstance<TTask>} An object containing the current state of the runs and any error encountered
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { runs, error } = useRealtimeRunsWithTag<typeof myTask>('my-tag');
 * // Or with multiple tags
 * const { runs, error } = useRealtimeRunsWithTag<typeof myTask>(['tag1', 'tag2']);
 * // Or with a createdAt filter
 * const { runs, error } = useRealtimeRunsWithTag<typeof myTask>('my-tag', { createdAt: '1h' });
 * ```
 */
export function useRealtimeRunsWithTag<TTask extends AnyTask>(
  tag: string | string[],
  options?: UseRealtimeRunsWithTagOptions
): UseRealtimeRunsInstance<TTask> {
  const hookId = useId();
  const idKey = options?.id ?? hookId;

  // Store the streams state in SWR, using the idKey as the key to share states.
  const { data: runs, mutate: mutateRuns } = useSWR<RealtimeRun<TTask>[]>([idKey, "run"], null, {
    fallbackData: [],
  });

  // Keep the latest streams in a ref.
  const runsRef = useRef<RealtimeRun<TTask>[]>([]);
  useEffect(() => {
    runsRef.current = runs ?? [];
  }, [runs]);

  const { data: error = undefined, mutate: setError } = useSWR<undefined | Error>(
    [idKey, "error"],
    null
  );

  // Abort controller to cancel the current API call.
  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const apiClient = useApiClient(options);

  const triggerRequest = useCallback(async () => {
    try {
      if (!apiClient) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeRunsWithTag(
        tag,
        { createdAt: options?.createdAt },
        apiClient,
        mutateRuns,
        runsRef,
        setError,
        abortControllerRef
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  }, [tag, mutateRuns, runsRef, abortControllerRef, apiClient, setError]);

  useEffect(() => {
    if (typeof options?.enabled === "boolean" && !options.enabled) {
      return;
    }

    triggerRequest().finally(() => {});

    return () => {
      stop();
    };
  }, [tag, stop, options?.enabled]);

  return { runs: runs ?? [], error, stop };
}

/**
 * Hook to subscribe to realtime updates of a batch of task runs.
 *
 * @template TTask - The type of the task
 * @param {string} batchId - The unique identifier of the batch to subscribe to
 * @param {UseRealtimeRunOptions} [options] - Configuration options for the subscription
 * @returns {UseRealtimeRunsInstance<TTask>} An object containing the current state of the runs, error handling, and control methods
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { runs, error } = useRealtimeBatch<typeof myTask>('batch-id-123');
 * ```
 */

export function useRealtimeBatch<TTask extends AnyTask>(
  batchId: string,
  options?: UseRealtimeRunOptions
): UseRealtimeRunsInstance<TTask> {
  const hookId = useId();
  const idKey = options?.id ?? hookId;

  // Store the streams state in SWR, using the idKey as the key to share states.
  const { data: runs, mutate: mutateRuns } = useSWR<RealtimeRun<TTask>[]>([idKey, "run"], null, {
    fallbackData: [],
  });

  // Keep the latest streams in a ref.
  const runsRef = useRef<RealtimeRun<TTask>[]>([]);
  useEffect(() => {
    runsRef.current = runs ?? [];
  }, [runs]);

  const { data: error = undefined, mutate: setError } = useSWR<undefined | Error>(
    [idKey, "error"],
    null
  );

  // Abort controller to cancel the current API call.
  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const apiClient = useApiClient(options);

  const triggerRequest = useCallback(async () => {
    try {
      if (!apiClient) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeBatch(
        batchId,
        apiClient,
        mutateRuns,
        runsRef,
        setError,
        abortControllerRef
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  }, [batchId, mutateRuns, runsRef, abortControllerRef, apiClient, setError]);

  useEffect(() => {
    if (typeof options?.enabled === "boolean" && !options.enabled) {
      return;
    }

    triggerRequest().finally(() => {});

    return () => {
      stop();
    };
  }, [batchId, stop, options?.enabled]);

  return { runs: runs ?? [], error, stop };
}

async function processRealtimeBatch<TTask extends AnyTask = AnyTask>(
  batchId: string,
  apiClient: ApiClient,
  mutateRunsData: KeyedMutator<RealtimeRun<TTask>[]>,
  existingRunsRef: React.MutableRefObject<RealtimeRun<TTask>[]>,
  onError: (e: Error) => void,
  abortControllerRef: React.MutableRefObject<AbortController | null>
) {
  const subscription = apiClient.subscribeToBatch<InferRunTypes<TTask>>(batchId, {
    signal: abortControllerRef.current?.signal,
    onFetchError: onError,
  });

  for await (const part of subscription) {
    mutateRunsData(insertRunShapeInOrder(existingRunsRef.current, part));
  }
}

// Inserts and then orders by the run number, and ensures that the run is not duplicated
function insertRunShapeInOrder<TTask extends AnyTask>(
  previousRuns: RealtimeRun<TTask>[],
  run: RealtimeRun<TTask>
) {
  const existingRun = previousRuns.find((r) => r.id === run.id);
  if (existingRun) {
    return previousRuns.map((r) => (r.id === run.id ? run : r));
  }

  const runNumber = run.number;
  const index = previousRuns.findIndex((r) => r.number > runNumber);
  if (index === -1) {
    return [...previousRuns, run];
  }

  return [...previousRuns.slice(0, index), run, ...previousRuns.slice(index)];
}

async function processRealtimeRunsWithTag<TTask extends AnyTask = AnyTask>(
  tag: string | string[],
  filters: { createdAt?: string },
  apiClient: ApiClient,
  mutateRunsData: KeyedMutator<RealtimeRun<TTask>[]>,
  existingRunsRef: React.MutableRefObject<RealtimeRun<TTask>[]>,
  onError: (e: Error) => void,
  abortControllerRef: React.MutableRefObject<AbortController | null>
) {
  const subscription = apiClient.subscribeToRunsWithTag<InferRunTypes<TTask>>(tag, filters, {
    signal: abortControllerRef.current?.signal,
    onFetchError: onError,
  });

  for await (const part of subscription) {
    mutateRunsData(insertRunShape(existingRunsRef.current, part));
  }
}

// Replaces or inserts a run shape, ordered by the createdAt timestamp
function insertRunShape<TTask extends AnyTask>(
  previousRuns: RealtimeRun<TTask>[],
  run: RealtimeRun<TTask>
) {
  const existingRun = previousRuns.find((r) => r.id === run.id);
  if (existingRun) {
    return previousRuns.map((r) => (r.id === run.id ? run : r));
  }

  const createdAt = run.createdAt;

  const index = previousRuns.findIndex((r) => r.createdAt > createdAt);

  if (index === -1) {
    return [...previousRuns, run];
  }

  return [...previousRuns.slice(0, index), run, ...previousRuns.slice(index)];
}

async function processRealtimeRunWithStreams<
  TTask extends AnyTask = AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
>(
  runId: string,
  apiClient: ApiClient,
  mutateRunData: KeyedMutator<RealtimeRun<TTask>>,
  mutateStreamData: KeyedMutator<StreamResults<TStreams>>,
  existingDataRef: React.MutableRefObject<StreamResults<TStreams>>,
  onError: (e: Error) => void,
  abortControllerRef: React.MutableRefObject<AbortController | null>,
  stopOnCompletion: boolean = true,
  throttleInMs?: number
) {
  const subscription = apiClient.subscribeToRun<InferRunTypes<TTask>>(runId, {
    signal: abortControllerRef.current?.signal,
    closeOnComplete: stopOnCompletion,
    onFetchError: onError,
  });

  type StreamUpdate = {
    type: keyof TStreams;
    chunk: any;
  };

  const streamQueue = createThrottledQueue<StreamUpdate>(async (updates) => {
    const nextStreamData = { ...existingDataRef.current };

    // Group updates by type
    const updatesByType = updates.reduce(
      (acc, update) => {
        if (!acc[update.type]) {
          acc[update.type] = [];
        }
        acc[update.type].push(update.chunk);
        return acc;
      },
      {} as Record<keyof TStreams, any[]>
    );

    // Apply all updates
    for (const [type, chunks] of Object.entries(updatesByType)) {
      // @ts-ignore
      nextStreamData[type] = [...(existingDataRef.current[type] || []), ...chunks];
    }

    mutateStreamData(nextStreamData);
  }, throttleInMs);

  for await (const part of subscription.withStreams<TStreams>()) {
    if (part.type === "run") {
      mutateRunData(part.run);
    } else {
      streamQueue.add({
        type: part.type,
        // @ts-ignore
        chunk: part.chunk,
      });
    }
  }
}

async function processRealtimeRun<TTask extends AnyTask = AnyTask>(
  runId: string,
  apiClient: ApiClient,
  mutateRunData: KeyedMutator<RealtimeRun<TTask>>,
  onError: (e: Error) => void,
  abortControllerRef: React.MutableRefObject<AbortController | null>,
  stopOnCompletion: boolean = true
) {
  const subscription = apiClient.subscribeToRun<InferRunTypes<TTask>>(runId, {
    signal: abortControllerRef.current?.signal,
    closeOnComplete: stopOnCompletion,
    onFetchError: onError,
  });

  for await (const part of subscription) {
    mutateRunData(part);
  }
}
