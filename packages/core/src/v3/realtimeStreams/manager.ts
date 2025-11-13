import { ApiClient } from "../apiClient/index.js";
import { ensureAsyncIterable, ensureReadableStream } from "../streams/asyncIterableStream.js";
import { taskContext } from "../task-context-api.js";
import { StreamInstance } from "./streamInstance.js";
import {
  RealtimeStreamInstance,
  RealtimeStreamOperationOptions,
  RealtimeStreamsManager,
} from "./types.js";

export class StandardRealtimeStreamsManager implements RealtimeStreamsManager {
  constructor(
    private apiClient: ApiClient,
    private baseUrl: string,
    private debug: boolean = false
  ) {}
  // Track active streams - using a Set allows multiple streams for the same key to coexist
  private activeStreams = new Set<{
    wait: () => Promise<void>;
    abortController: AbortController;
  }>();

  reset(): void {
    this.activeStreams.clear();
  }

  public pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimeStreamOperationOptions
  ): RealtimeStreamInstance<T> {
    // Normalize ReadableStream to AsyncIterable
    const readableStreamSource = ensureReadableStream(source);

    const runId = getRunIdForOptions(options);

    if (!runId) {
      throw new Error(
        "Could not determine the target run ID for the realtime stream. Please specify a target run ID using the `target` option."
      );
    }

    // Create an AbortController for this stream
    const abortController = new AbortController();
    // Chain with user-provided signal if present
    const combinedSignal = options?.signal
      ? AbortSignal.any?.([options.signal, abortController.signal]) ?? abortController.signal
      : abortController.signal;

    const streamInstance = new StreamInstance({
      apiClient: this.apiClient,
      baseUrl: this.baseUrl,
      runId,
      key,
      source: readableStreamSource,
      signal: combinedSignal,
      requestOptions: options?.requestOptions,
      target: options?.target,
      debug: this.debug,
    });

    // Register this stream
    const streamInfo = { wait: () => streamInstance.wait(), abortController };
    this.activeStreams.add(streamInfo);

    // Clean up when stream completes
    streamInstance.wait().finally(() => this.activeStreams.delete(streamInfo));

    return {
      wait: () => streamInstance.wait(),
      stream: streamInstance.stream,
    };
  }

  public async append<TPart extends BodyInit>(
    key: string,
    part: TPart,
    options?: RealtimeStreamOperationOptions
  ): Promise<void> {
    const runId = getRunIdForOptions(options);

    if (!runId) {
      throw new Error(
        "Could not determine the target run ID for the realtime stream. Please specify a target run ID using the `target` option."
      );
    }

    const result = await this.apiClient.appendToStream(
      runId,
      "self",
      key,
      part,
      options?.requestOptions
    );

    if (!result.ok) {
      throw new Error(`Failed to append to stream: ${result.message ?? "Unknown error"}`);
    }
  }

  public hasActiveStreams(): boolean {
    return this.activeStreams.size > 0;
  }

  // Waits for all the streams to finish
  public async waitForAllStreams(timeout: number = 60_000): Promise<void> {
    if (this.activeStreams.size === 0) {
      return;
    }

    const promises = Array.from(this.activeStreams).map((stream) => stream.wait());

    // Create a timeout promise that resolves to a special sentinel value
    const TIMEOUT_SENTINEL = Symbol("timeout");
    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
      setTimeout(() => resolve(TIMEOUT_SENTINEL), timeout)
    );

    // Race between all streams completing/rejecting and the timeout
    const result = await Promise.race([Promise.all(promises), timeoutPromise]);

    // Check if we timed out
    if (result === TIMEOUT_SENTINEL) {
      // Timeout occurred - abort all active streams
      const abortedCount = this.activeStreams.size;
      for (const streamInfo of this.activeStreams) {
        streamInfo.abortController.abort();
        this.activeStreams.delete(streamInfo);
      }

      throw new Error(
        `Timeout waiting for streams to finish after ${timeout}ms. Aborted ${abortedCount} active stream(s).`
      );
    }

    // If we reach here, Promise.all completed (either all resolved or one rejected)
    // Any rejection from Promise.all will have already propagated
  }
}

function getRunIdForOptions(options?: RealtimeStreamOperationOptions): string | undefined {
  if (options?.target) {
    if (options.target === "parent") {
      return taskContext.ctx?.run?.parentTaskRunId ?? taskContext.ctx?.run?.id;
    }

    if (options.target === "root") {
      return taskContext.ctx?.run?.rootTaskRunId ?? taskContext.ctx?.run?.id;
    }

    if (options.target === "self") {
      return taskContext.ctx?.run?.id;
    }

    return options.target;
  }

  return taskContext.ctx?.run?.id;
}

type ParsedStreamResponse =
  | {
      version: "v1";
    }
  | {
      version: "v2";
      accessToken: string;
      basin: string;
      flushIntervalMs?: number;
      maxRetries?: number;
    };

function parseCreateStreamResponse(
  version: string,
  headers: Record<string, string> | undefined
): ParsedStreamResponse {
  if (version === "v1") {
    return { version: "v1" };
  }

  const accessToken = headers?.["x-s2-access-token"];
  const basin = headers?.["x-s2-basin"];

  if (!accessToken || !basin) {
    return { version: "v1" };
  }

  const flushIntervalMs = headers?.["x-s2-flush-interval-ms"];
  const maxRetries = headers?.["x-s2-max-retries"];

  return {
    version: "v2",
    accessToken,
    basin,
    flushIntervalMs: flushIntervalMs ? parseInt(flushIntervalMs) : undefined,
    maxRetries: maxRetries ? parseInt(maxRetries) : undefined,
  };
}
