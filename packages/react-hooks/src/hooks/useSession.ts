"use client";

import type { ApiClient, ControlEvent, SSEStreamPart } from "@trigger.dev/core/v3";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createThrottledQueue } from "../utils/throttle.js";
import type { KeyedMutator } from "../utils/trigger-swr.js";
import { useSWR } from "../utils/trigger-swr.js";
import { useStableRequestCallback } from "../utils/useStableRequestCallback.js";
import type { UseApiClientOptions } from "./useApiClient.js";
import { useApiClient } from "./useApiClient.js";

export type UseSessionInstance<TRecord> = {
  /**
   * The records received so far on the channel, in arrival order. Control records are
   * never included here, they are delivered to `onControl` instead.
   */
  records: Array<TRecord>;

  /**
   * The cursor of the last record seen. Persist this and pass it back as the `lastEventId`
   * option to resume the channel where you left off.
   */
  lastEventId: string | undefined;

  /**
   * The last control record seen on the channel (e.g. `turn-complete`).
   */
  lastControl: ControlEvent | undefined;

  error: Error | undefined;

  /**
   * Abort the current request immediately, keep the records received so far.
   */
  stop: () => void;
};

export type UseSessionOptions<TRecord> = UseApiClientOptions & {
  id?: string;
  enabled?: boolean;
  /**
   * Which channel of the session to read.
   *
   * @default "out"
   */
  io?: "out" | "in";
  /**
   * The number of milliseconds to throttle the record updates.
   *
   * @default 16
   */
  throttleInMs?: number;
  /**
   * The number of seconds to wait for new data to be available,
   * If no data arrives within the timeout, the stream will be closed.
   *
   * @default 60 seconds
   */
  timeoutInSeconds?: number;
  /**
   * The cursor to resume from. If not provided, the channel is read from the beginning.
   */
  lastEventId?: string | number;
  /**
   * Callback this is called when a record is received, before throttling. This fires for
   * control records too, so you can track the cursor for every record on the channel.
   */
  onRecord?: (record: SSEStreamPart<TRecord>) => void;
  /**
   * Callback this is called when a control record is received (e.g. `turn-complete`).
   */
  onControl?: (event: ControlEvent) => void;
};

/**
 * Hook to subscribe to a Session channel.
 *
 * This hook automatically subscribes to one of the session's channels and updates the `records`
 * array as new records arrive. The subscription is automatically managed: it starts when the
 * component mounts (or when `enabled` becomes `true`) and stops when the component unmounts or
 * when `stop()` is called.
 *
 * Requires a Public Access Token with the `read:sessions:{id}` scope.
 *
 * @template TRecord - The type of each record on the channel
 * @param sessionIdOrExternalId - The id or external id of the session to subscribe to
 * @param options - Optional configuration for the subscription
 * @returns An object containing:
 *   - `records`: An array of all the records received so far (accumulates over time)
 *   - `lastEventId`: The cursor of the last record seen, for resuming later
 *   - `lastControl`: The last control record seen
 *   - `error`: Any error that occurred during subscription
 *   - `stop`: A function to manually stop the subscription
 *
 * @example
 * ```tsx
 * "use client";
 * import { useSession } from "@trigger.dev/react-hooks";
 *
 * function SessionViewer({ sessionId }: { sessionId: string }) {
 *   const { records, error } = useSession<string>(sessionId, {
 *     accessToken: publicAccessToken,
 *   });
 *
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return <div>{records.join("")}</div>;
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Read the input channel, resuming from a persisted cursor
 * const { records, lastEventId, stop } = useSession<MyRecord>(sessionId, {
 *   accessToken: publicAccessToken,
 *   io: "in",
 *   lastEventId: persistedCursor,
 *   onControl: (event) => {
 *     if (event.subtype === "turn-complete") {
 *       console.log("The turn is complete");
 *     }
 *   },
 * });
 * ```
 */
export function useSession<TRecord = unknown>(
  sessionIdOrExternalId?: string,
  options?: UseSessionOptions<TRecord>
): UseSessionInstance<TRecord> {
  const hookId = useId();
  const idKey = options?.id ?? hookId;
  const io = options?.io ?? "out";

  const [initialRecordsFallback] = useState([] as Array<TRecord>);

  // Store the records state in SWR, using the idKey as the key to share states.
  const { data: records, mutate: mutateRecords } = useSWR<Array<TRecord>>(
    [idKey, sessionIdOrExternalId, io, "records"],
    null,
    {
      fallbackData: initialRecordsFallback,
    }
  );

  // Keep the latest records in a ref.
  const recordsRef = useRef<Array<TRecord>>(records ?? ([] as Array<TRecord>));
  useEffect(() => {
    recordsRef.current = records || ([] as Array<TRecord>);
  }, [records]);

  const { data: lastEventId = undefined, mutate: setLastEventId } = useSWR<undefined | string>(
    [idKey, sessionIdOrExternalId, io, "lastEventId"],
    null
  );

  const { data: lastControl = undefined, mutate: setLastControl } = useSWR<
    undefined | ControlEvent
  >([idKey, sessionIdOrExternalId, io, "lastControl"], null);

  // Add state to track when the subscription is complete
  const { data: _isComplete = false, mutate: setIsComplete } = useSWR<boolean>(
    [idKey, sessionIdOrExternalId, io, "complete"],
    null
  );

  const { data: error = undefined, mutate: setError } = useSWR<undefined | Error>(
    [idKey, sessionIdOrExternalId, io, "error"],
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

  const onRecordCallback = options?.onRecord;
  const onRecord = useCallback(
    (record: SSEStreamPart<TRecord>) => {
      if (onRecordCallback) {
        onRecordCallback(record);
      }
    },
    [onRecordCallback]
  );

  const onControlCallback = options?.onControl;
  const onControl = useCallback(
    (event: ControlEvent) => {
      if (onControlCallback) {
        onControlCallback(event);
      }
    },
    [onControlCallback]
  );

  const apiClient = useApiClient(options);
  const timeoutInSeconds = options?.timeoutInSeconds;
  const startEventId = options?.lastEventId;
  const throttleInMs = options?.throttleInMs;

  const triggerRequest = useCallback(async () => {
    try {
      if (!sessionIdOrExternalId || !apiClient) {
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processSessionStream<TRecord>(
        sessionIdOrExternalId,
        io,
        apiClient,
        mutateRecords,
        recordsRef,
        setLastEventId,
        setLastControl,
        setError,
        onRecord,
        onControl,
        abortControllerRef,
        timeoutInSeconds,
        startEventId !== undefined ? String(startEventId) : undefined,
        throttleInMs ?? 16
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
  }, [
    sessionIdOrExternalId,
    io,
    apiClient,
    mutateRecords,
    setLastEventId,
    setLastControl,
    setError,
    setIsComplete,
    onRecord,
    onControl,
    timeoutInSeconds,
    startEventId,
    throttleInMs,
  ]);
  const requestSubscription = useStableRequestCallback(triggerRequest);

  useEffect(() => {
    if (typeof options?.enabled === "boolean" && !options.enabled) {
      return;
    }

    if (!sessionIdOrExternalId) {
      return;
    }

    requestSubscription().finally(() => {});

    return () => {
      stop();
    };
  }, [sessionIdOrExternalId, io, stop, options?.enabled, requestSubscription]);

  return { records: records ?? initialRecordsFallback, lastEventId, lastControl, error, stop };
}

async function processSessionStream<TRecord>(
  sessionIdOrExternalId: string,
  io: "out" | "in",
  apiClient: ApiClient,
  mutateRecordsData: KeyedMutator<Array<TRecord>>,
  existingRecordsRef: React.MutableRefObject<Array<TRecord>>,
  setLastEventId: KeyedMutator<undefined | string>,
  setLastControl: KeyedMutator<undefined | ControlEvent>,
  onError: (e: Error) => void,
  onRecord: (record: SSEStreamPart<TRecord>) => void,
  onControl: (event: ControlEvent) => void,
  abortControllerRef: React.MutableRefObject<AbortController | null>,
  timeoutInSeconds?: number,
  lastEventId?: string,
  throttleInMs?: number
) {
  // Published with the throttled record flush, so consumers re-render once per
  // batch instead of once per record.
  let lastSeenEventId: string | undefined;
  let publishedEventId: string | undefined;

  const publishLastEventId = () => {
    if (lastSeenEventId !== publishedEventId) {
      publishedEventId = lastSeenEventId;
      setLastEventId(lastSeenEventId);
    }
  };

  try {
    const stream = await apiClient.subscribeToSessionStream<TRecord>(sessionIdOrExternalId, io, {
      signal: abortControllerRef.current?.signal,
      timeoutInSeconds,
      lastEventId,
      onPart: (part) => {
        lastSeenEventId = part.id;
        onRecord(part);
      },
      onControl: (event) => {
        setLastControl(event);
        onControl(event);
      },
    });

    // Throttle the records
    const recordsQueue = createThrottledQueue<TRecord>(async (newRecords) => {
      mutateRecordsData([...existingRecordsRef.current, ...newRecords]);
      publishLastEventId();
    }, throttleInMs);

    for await (const record of stream) {
      recordsQueue.add(record);
    }

    // The last batch can be smaller than the throttle window, so flush it. The
    // cursor is published even when that batch is empty (control records only).
    await recordsQueue.flush();
    publishLastEventId();
  } catch (err) {
    if ((err as any).name === "AbortError") {
      return;
    }

    if (err instanceof Error) {
      onError(err);
    } else {
      onError(new Error(String(err)));
    }

    throw err;
  }
}
