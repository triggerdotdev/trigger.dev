"use client";

import { AnyTask, ApiClient, InferRunTypes, RealtimeRun } from "@trigger.dev/core/v3";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { throttle } from "../utils/throttle.js";
import { KeyedMutator, useSWR } from "../utils/trigger-swr.js";
import { useApiClient, UseApiClientOptions } from "./useApiClient.js";

export type UseRealtimeRunOptions = UseApiClientOptions & {
  id?: string;
  enabled?: boolean;
  experimental_throttleInMs?: number;
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
 * hook to subscribe to realtime updates of a task run.
 *
 * @template TTask - The type of the task.
 * @param {string} runId - The unique identifier of the run to subscribe to.
 * @returns {{ run: RealtimeRun<TTask> | undefined, error: Error | null }} An object containing the current state of the run and any error encountered.
 *
 * @example
 * ```ts
 * import type { myTask } from './path/to/task';
 * const { run, error } = useRealtimeRun<typeof myTask>('run-id-123');
 * ```
 */
export function useRealtimeRun<TTask extends AnyTask>(
  runId?: string,
  options?: UseRealtimeRunOptions
): UseRealtimeRunInstance<TTask> {
  const hookId = useId();
  const idKey = options?.id ?? hookId;

  // Store the streams state in SWR, using the idKey as the key to share states.
  const { data: run, mutate: mutateRun } = useSWR<RealtimeRun<TTask>>([idKey, "run"], null);

  // Keep the latest streams in a ref.
  const runRef = useRef<RealtimeRun<TTask> | undefined>();
  useEffect(() => {
    runRef.current = run;
  }, [run]);

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
      if (!runId) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeRun(
        runId,
        apiClient,
        throttle(mutateRun, options?.experimental_throttleInMs),
        abortControllerRef
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
    }
  }, [runId, mutateRun, abortControllerRef, apiClient, setError]);

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

export function useRealtimeRunWithStreams<
  TTask extends AnyTask = AnyTask,
  TStreams extends Record<string, any> = Record<string, any>,
>(
  runId?: string,
  options?: UseRealtimeRunOptions
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

  // Keep the latest streams in a ref.
  const runRef = useRef<RealtimeRun<TTask> | undefined>();
  useEffect(() => {
    runRef.current = run;
  }, [run]);

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
      if (!runId) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeRunWithStreams(
        runId,
        apiClient,
        throttle(mutateRun, options?.experimental_throttleInMs),
        throttle(mutateStreams, options?.experimental_throttleInMs),
        streamsRef,
        abortControllerRef
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
    }
  }, [runId, mutateRun, mutateStreams, streamsRef, abortControllerRef, apiClient, setError]);

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

export function useRealtimeRunsWithTag<TTask extends AnyTask>(
  tag: string | string[],
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
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeRunsWithTag(
        tag,
        apiClient,
        throttle(mutateRuns, options?.experimental_throttleInMs),
        runsRef,
        abortControllerRef
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
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
 * hook to subscribe to realtime updates of a batch of task runs.
 *
 * @template TTask - The type of the task.
 * @param {string} batchId - The unique identifier of the batch to subscribe to.
 * @returns {{ runs: RealtimeRun<TTask>[], error: Error | null }} An object containing the current state of the runs and any error encountered.
 *
 * @example
 *
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
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processRealtimeBatch(
        batchId,
        apiClient,
        throttle(mutateRuns, options?.experimental_throttleInMs),
        runsRef,
        abortControllerRef
      );
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === "AbortError") {
        abortControllerRef.current = null;
        return;
      }

      setError(err as Error);
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
  abortControllerRef: React.MutableRefObject<AbortController | null>
) {
  const subscription = apiClient.subscribeToBatch<InferRunTypes<TTask>>(batchId, {
    signal: abortControllerRef.current?.signal,
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
  apiClient: ApiClient,
  mutateRunsData: KeyedMutator<RealtimeRun<TTask>[]>,
  existingRunsRef: React.MutableRefObject<RealtimeRun<TTask>[]>,
  abortControllerRef: React.MutableRefObject<AbortController | null>
) {
  const subscription = apiClient.subscribeToRunsWithTag<InferRunTypes<TTask>>(tag, {
    signal: abortControllerRef.current?.signal,
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
  abortControllerRef: React.MutableRefObject<AbortController | null>
) {
  const subscription = apiClient.subscribeToRun<InferRunTypes<TTask>>(runId, {
    signal: abortControllerRef.current?.signal,
  });

  for await (const part of subscription.withStreams<TStreams>()) {
    if (part.type === "run") {
      mutateRunData(part.run);
    } else {
      const nextStreamData = {
        ...existingDataRef.current,
        // @ts-ignore
        [part.type]: [...(existingDataRef.current[part.type] || []), part.chunk],
      };

      mutateStreamData(nextStreamData);
    }
  }
}

async function processRealtimeRun<TTask extends AnyTask = AnyTask>(
  runId: string,
  apiClient: ApiClient,
  mutateRunData: KeyedMutator<RealtimeRun<TTask>>,
  abortControllerRef: React.MutableRefObject<AbortController | null>
) {
  const subscription = apiClient.subscribeToRun<InferRunTypes<TTask>>(runId, {
    signal: abortControllerRef.current?.signal,
  });

  for await (const part of subscription) {
    mutateRunData(part);
  }
}
