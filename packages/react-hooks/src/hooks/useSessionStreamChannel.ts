"use client";

import type {
  AnySessionChannel,
  ApiClient,
  ControlEvent,
  SessionChannelIn,
  SessionChannelName,
  SessionChannelOut,
  SSEStreamPart,
} from "@trigger.dev/core/v3";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createThrottledQueue } from "../utils/throttle.js";
import type { KeyedMutator } from "../utils/trigger-swr.js";
import { useSWR } from "../utils/trigger-swr.js";
import { useStableRequestCallback } from "../utils/useStableRequestCallback.js";
import type { UseApiClientOptions } from "./useApiClient.js";
import { useApiClient } from "./useApiClient.js";

type ChannelRecord<TChannel extends AnySessionChannel, S extends "in" | "out"> = S extends "out"
  ? SessionChannelOut<TChannel>
  : SessionChannelIn<TChannel>;

export type UseSessionStreamChannelInstance<TRecord> = {
  /** The records received so far on the channel, in arrival order. */
  records: Array<TRecord>;
  /** The cursor of the last record seen; pass back as `lastEventId` to resume. */
  lastEventId: string | undefined;
  /** The last control record seen on the channel. */
  lastControl: ControlEvent | undefined;
  error: Error | undefined;
  /** Abort the current request immediately, keep the records received so far. */
  stop: () => void;
};

export type UseSessionStreamChannelOptions<
  TChannel extends AnySessionChannel,
  S extends "in" | "out",
> = UseApiClientOptions & {
  /**
   * The id or external id of the session that owns the channel. May be
   * undefined while it resolves; the subscription starts once it is set.
   */
  sessionId?: string;
  id?: string;
  enabled?: boolean;
  /**
   * Which side of the channel to read.
   *
   * @default "out"
   */
  io?: S;
  /**
   * The number of milliseconds to throttle the record updates.
   *
   * @default 16
   */
  throttleInMs?: number;
  /**
   * The number of seconds to wait for new data before the stream closes.
   *
   * @default 60 seconds
   */
  timeoutInSeconds?: number;
  /** The cursor to resume from. If not provided, reads per `from`. */
  lastEventId?: string | number;
  /**
   * Where a fresh subscription (no `lastEventId`) starts reading.
   *
   * - `"beginning"` (default): replay the full channel history, then live-tail.
   * - `"latest"`: start at the current tail, for a last-value / live view.
   *
   * Ignored when `lastEventId` is set.
   */
  from?: "beginning" | "latest";
  /**
   * Cap the number of records kept in `records`. Use `maxRecords: 1` with
   * `from: "latest"` for a bounded last-value view.
   */
  maxRecords?: number;
  /** Invoked once per throttled flush with the batch of records (control records included). */
  onRecords?: (records: Array<SSEStreamPart<ChannelRecord<TChannel, S>>>) => void;
  /** Called when a control record is received on the channel. */
  onControl?: (event: ControlEvent) => void;
};

/**
 * Read one side of a named Session side channel, with record types inferred
 * from a `defineSessionChannel` declaration passed as the type argument.
 *
 * The channel name is typesafe (`SessionChannelName<TChannel>`) and `records`
 * is typed from the channel's `.out` / `.in` record type. Called without the
 * type argument, the channel name is any string and `records` is `unknown`.
 *
 * Requires a Public Access Token scoped to the session (or to the channel).
 *
 * @example
 * ```tsx
 * import type { screenshotsChannel } from "./shared/channels";
 *
 * const { records } = useSessionStreamChannel<typeof screenshotsChannel>("screenshots", {
 *   sessionId,
 *   accessToken,
 *   io: "out",
 *   from: "latest",
 *   maxRecords: 1,
 * });
 * ```
 */
export function useSessionStreamChannel<
  TChannel extends AnySessionChannel = AnySessionChannel,
  S extends "in" | "out" = "out",
>(
  channel: SessionChannelName<TChannel>,
  options: UseSessionStreamChannelOptions<TChannel, S>
): UseSessionStreamChannelInstance<ChannelRecord<TChannel, S>> {
  type TRecord = ChannelRecord<TChannel, S>;

  const hookId = useId();
  const idKey = options.id ?? hookId;
  const io = (options.io ?? "out") as "out" | "in";
  const sessionId = options.sessionId;
  const channelName = channel as string;

  const [initialRecordsFallback] = useState([] as Array<TRecord>);

  const { data: records, mutate: mutateRecords } = useSWR<Array<TRecord>>(
    [idKey, sessionId, channelName, io, "records"],
    null,
    { fallbackData: initialRecordsFallback }
  );

  const recordsRef = useRef<Array<TRecord>>(records ?? ([] as Array<TRecord>));
  useEffect(() => {
    recordsRef.current = records || ([] as Array<TRecord>);
  }, [records]);

  const { data: lastEventId = undefined, mutate: setLastEventId } = useSWR<undefined | string>(
    [idKey, sessionId, channelName, io, "lastEventId"],
    null
  );
  const lastEventIdRef = useRef<string | undefined>(lastEventId);
  const channelIdentityRef = useRef(`${idKey}:${sessionId}:${channelName}:${io}`);
  useEffect(() => {
    const identity = `${idKey}:${sessionId}:${channelName}:${io}`;
    if (channelIdentityRef.current !== identity) {
      channelIdentityRef.current = identity;
      lastEventIdRef.current = lastEventId;
    }
  }, [idKey, sessionId, channelName, io, lastEventId]);

  const { data: lastControl = undefined, mutate: setLastControl } = useSWR<
    undefined | ControlEvent
  >([idKey, sessionId, channelName, io, "lastControl"], null);

  const { data: _isComplete = false, mutate: setIsComplete } = useSWR<boolean>(
    [idKey, sessionId, channelName, io, "complete"],
    null
  );

  const { data: error = undefined, mutate: setError } = useSWR<undefined | Error>(
    [idKey, sessionId, channelName, io, "error"],
    null
  );

  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const onRecordsCallback = options.onRecords;
  const onRecords = useCallback(
    (recordsBatch: Array<SSEStreamPart<TRecord>>) => {
      if (onRecordsCallback) {
        onRecordsCallback(recordsBatch);
      }
    },
    [onRecordsCallback]
  );

  const onControlCallback = options.onControl;
  const onControl = useCallback(
    (event: ControlEvent) => {
      if (onControlCallback) {
        onControlCallback(event);
      }
    },
    [onControlCallback]
  );

  const apiClient = useApiClient(options);
  const timeoutInSeconds = options.timeoutInSeconds;
  const startEventId = options.lastEventId;
  const throttleInMs = options.throttleInMs;
  const from = options.from;
  const maxRecords = options.maxRecords;

  useEffect(() => {
    if (maxRecords != null && maxRecords >= 0) {
      const current = recordsRef.current;
      if (current.length > maxRecords) {
        mutateRecords(current.slice(current.length - maxRecords));
      }
    }
  }, [maxRecords, mutateRecords]);

  const triggerRequest = useCallback(async () => {
    let abortController: AbortController | null = null;
    try {
      if (!sessionId || !apiClient) {
        return;
      }

      abortController = new AbortController();
      abortControllerRef.current = abortController;

      await processSessionChannelStream<TRecord>(
        sessionId,
        io,
        channelName,
        apiClient,
        mutateRecords,
        recordsRef,
        setLastEventId,
        setLastControl,
        setError,
        onRecords,
        onControl,
        abortControllerRef,
        timeoutInSeconds,
        startEventId !== undefined ? String(startEventId) : lastEventIdRef.current,
        throttleInMs ?? 16,
        from,
        maxRecords
      );
    } catch (err) {
      if ((err as any).name === "AbortError") {
        return;
      }

      setError(err as Error);
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }

      setIsComplete(true);
    }
  }, [
    sessionId,
    io,
    channelName,
    apiClient,
    mutateRecords,
    setLastEventId,
    setLastControl,
    setError,
    setIsComplete,
    onRecords,
    onControl,
    timeoutInSeconds,
    startEventId,
    throttleInMs,
    from,
    maxRecords,
  ]);
  const requestSubscription = useStableRequestCallback(triggerRequest);

  useEffect(() => {
    if (typeof options.enabled === "boolean" && !options.enabled) {
      return;
    }

    if (!sessionId) {
      return;
    }

    requestSubscription().finally(() => {});

    return () => {
      stop();
    };
  }, [sessionId, channelName, io, stop, options.enabled, requestSubscription]);

  return { records: records ?? initialRecordsFallback, lastEventId, lastControl, error, stop };
}

async function processSessionChannelStream<TRecord>(
  sessionIdOrExternalId: string,
  io: "out" | "in",
  channel: string,
  apiClient: ApiClient,
  mutateRecordsData: KeyedMutator<Array<TRecord>>,
  existingRecordsRef: React.MutableRefObject<Array<TRecord>>,
  setLastEventId: KeyedMutator<undefined | string>,
  setLastControl: KeyedMutator<undefined | ControlEvent>,
  onError: (e: Error) => void,
  onRecords: (records: Array<SSEStreamPart<TRecord>>) => void,
  onControl: (event: ControlEvent) => void,
  abortControllerRef: React.MutableRefObject<AbortController | null>,
  timeoutInSeconds?: number,
  lastEventId?: string,
  throttleInMs?: number,
  from?: "beginning" | "latest",
  maxRecords?: number
) {
  let lastSeenEventId: string | undefined;
  let publishedEventId: string | undefined;
  let partsBatch: Array<SSEStreamPart<TRecord>> = [];

  const publishLastEventId = () => {
    if (lastSeenEventId !== publishedEventId) {
      publishedEventId = lastSeenEventId;
      setLastEventId(lastSeenEventId);
    }
  };

  const flushParts = () => {
    if (partsBatch.length === 0) return;
    const batch = partsBatch;
    partsBatch = [];
    onRecords(batch);
  };

  try {
    const stream = await apiClient.subscribeToSessionStream<TRecord>(sessionIdOrExternalId, io, {
      signal: abortControllerRef.current?.signal,
      channel,
      timeoutInSeconds,
      lastEventId,
      from,
      onPart: (part) => {
        lastSeenEventId = part.id;
        partsBatch.push(part);
      },
      onControl: (event) => {
        setLastControl(event);
        onControl(event);
      },
    });

    const recordsQueue = createThrottledQueue<TRecord>(async (newRecords) => {
      const combined = [...existingRecordsRef.current, ...newRecords];
      const bounded =
        maxRecords != null && maxRecords >= 0 && combined.length > maxRecords
          ? combined.slice(combined.length - maxRecords)
          : combined;
      existingRecordsRef.current = bounded;
      mutateRecordsData(bounded);
      publishLastEventId();
      flushParts();
    }, throttleInMs);

    for await (const record of stream) {
      recordsQueue.add(record);
    }

    await recordsQueue.flush();
    publishLastEventId();
    flushParts();
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
