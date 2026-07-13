import type { ApiClient } from "../apiClient/index.js";
import { ensureReadableStream } from "../streams/asyncIterableStream.js";
import { taskContext } from "../task-context-api.js";
import type { AnyZodFetchOptions } from "../zodfetch.js";
import type { CreateStreamResponseLike } from "./streamInstance.js";
import { StreamInstance } from "./streamInstance.js";
import type {
  RealtimeStreamInstance,
  RealtimeStreamOperationOptions,
  RealtimeStreamsManager,
  StreamWriteResult,
} from "./types.js";

export class StandardRealtimeStreamsManager implements RealtimeStreamsManager {
  constructor(
    private apiClient: ApiClient,
    private baseUrl: string,
    private debug: boolean = false
  ) {}
  // Track active streams - using a Set allows multiple streams for the same key to coexist
  private activeStreams = new Set<{
    wait: () => Promise<StreamWriteResult>;
    abortController: AbortController;
  }>();

  // Cache of in-flight / resolved `createStream` responses, keyed by
  // `${runId}:${key}`. S2 v2 access tokens are scoped to the org basin
  // (default 1-day TTL server-side) so reusing them across repeated
  // `pipe()` calls for the same `(runId, key)` is safe, and avoids the
  // per-call PUT that pushes `streamId` onto `TaskRun.realtimeStreams`,
  // which under chat-agent-style hot-loop writers caused row-lock
  // contention on the writer DB.
  private createStreamCache = new Map<string, Promise<CreateStreamResponseLike>>();

  reset(): void {
    this.activeStreams.clear();
    this.createStreamCache.clear();
  }

  private getCachedCreateStream(
    runId: string,
    key: string,
    requestOptions: AnyZodFetchOptions | undefined
  ): Promise<CreateStreamResponseLike> {
    const cacheKey = `${runId}:${key}`;
    const cached = this.createStreamCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = this.apiClient.createStream(runId, "self", key, requestOptions);
    this.createStreamCache.set(cacheKey, promise);
    // Evict on failure so the next call retries instead of returning a
    // poisoned cache entry forever.
    promise.catch((err) => {
      if (this.createStreamCache.get(cacheKey) === promise) {
        this.createStreamCache.delete(cacheKey);
      }
    });
    return promise;
  }

  /**
   * Reactive invalidation: a writer's `wait()` rejecting can mean the
   * cached S2 credentials have gone stale (expired token, revoked
   * access, basin retired), so evict the cached `createStream` response
   * for `(runId, key)` and let the next `pipe()` re-PUT to mint fresh
   * credentials. Compare by identity so a fresh promise installed by a
   * concurrent caller isn't accidentally cleared.
   */
  private evictCreateStreamIfStale(
    runId: string,
    key: string,
    expected: Promise<CreateStreamResponseLike>
  ): void {
    const cacheKey = `${runId}:${key}`;
    if (this.createStreamCache.get(cacheKey) === expected) {
      this.createStreamCache.delete(cacheKey);
    }
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
      ? (AbortSignal.any?.([options.signal, abortController.signal]) ?? abortController.signal)
      : abortController.signal;

    // Capture which cached promise this writer uses so reactive
    // invalidation below evicts only if the cache still holds it (a
    // concurrent caller may have already refreshed it).
    const activeCreatePromise = this.getCachedCreateStream(runId, key, options?.requestOptions);

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
      createStream: () => activeCreatePromise,
    });

    // Register this stream
    const streamInfo = { wait: () => streamInstance.wait(), abortController };
    this.activeStreams.add(streamInfo);

    // Single internal chain that handles activeStreams cleanup AND
    // reactive invalidation. On rejection we evict the cached
    // `createStream` entry so the next pipe() for the same `(runId, key)`
    // re-PUTs and recovers (e.g. when a cached S2 access token expired
    // mid-process). Customer awaiters still observe the rejection via
    // the returned `wait()`; this chain just keeps the cleanup path
    // from surfacing as unhandled.
    streamInstance.wait().then(
      () => {
        this.activeStreams.delete(streamInfo);
      },
      (err) => {
        this.evictCreateStreamIfStale(runId, key, activeCreatePromise);
        this.activeStreams.delete(streamInfo);
      }
    );

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
