import {
  AsyncIterableStream,
  createAsyncIterableStreamFromAsyncIterable,
  ensureAsyncIterable,
} from "../streams/asyncIterableStream.js";
import {
  RealtimeAppendStreamOptions,
  RealtimeStreamInstance,
  RealtimeStreamsManager,
} from "./types.js";
import { taskContext } from "../task-context-api.js";
import { ApiClient } from "../apiClient/index.js";
import { StreamsWriterV1 } from "./streamsWriterV1.js";
import { StreamsWriterV2 } from "./streamsWriterV2.js";

export class StandardRealtimeStreamsManager implements RealtimeStreamsManager {
  constructor(
    private apiClient: ApiClient,
    private baseUrl: string,
    private debug: boolean = false
  ) {}
  // Add a Map to track active streams
  private activeStreams = new Map<string, { wait: () => Promise<void> }>();

  reset(): void {
    this.activeStreams.clear();
  }

  public async append<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimeAppendStreamOptions
  ): Promise<RealtimeStreamInstance<T>> {
    // Normalize ReadableStream to AsyncIterable
    const asyncIterableSource = ensureAsyncIterable(source);

    const runId = getRunIdForOptions(options);

    if (!runId) {
      throw new Error(
        "Could not determine the target run ID for the realtime stream. Please specify a target run ID using the `target` option."
      );
    }

    const { version, headers } = await this.apiClient.createStream(
      runId,
      "self",
      key,
      options?.requestOptions
    );

    const parsedResponse = parseCreateStreamResponse(version, headers);

    const streamInstance =
      parsedResponse.version === "v1"
        ? new StreamsWriterV1({
            key,
            runId,
            source: asyncIterableSource,
            baseUrl: this.baseUrl,
            headers: this.apiClient.getHeaders(),
            signal: options?.signal,
            version,
            target: "self",
          })
        : new StreamsWriterV2({
            basin: parsedResponse.basin,
            stream: key,
            accessToken: parsedResponse.accessToken,
            source: asyncIterableSource,
            signal: options?.signal,
            limiter: (await import("p-limit")).default,
            debug: this.debug,
          });

    this.activeStreams.set(key, streamInstance);

    // Clean up when stream completes
    streamInstance.wait().finally(() => this.activeStreams.delete(key));

    return {
      wait: () => streamInstance.wait(),
      get stream(): AsyncIterableStream<T> {
        return createAsyncIterableStreamFromAsyncIterable(streamInstance);
      },
    };
  }

  public hasActiveStreams(): boolean {
    return this.activeStreams.size > 0;
  }

  // Waits for all the streams to finish
  public async waitForAllStreams(timeout: number = 60_000): Promise<void> {
    if (this.activeStreams.size === 0) {
      return;
    }

    const promises = Array.from(this.activeStreams.values()).map((stream) => stream.wait());

    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve, _) => setTimeout(() => resolve(), timeout)),
      ]);
    } catch (error) {
      console.error("Error waiting for streams to finish:", error);

      // If we time out, abort all remaining streams
      for (const [key, promise] of this.activeStreams.entries()) {
        // We can add abort logic here if needed
        this.activeStreams.delete(key);
      }
      throw error;
    }
  }
}

function getRunIdForOptions(options?: RealtimeAppendStreamOptions): string | undefined {
  if (options?.target) {
    if (options.target === "parent") {
      return taskContext.ctx?.run?.parentTaskRunId;
    }

    if (options.target === "root") {
      return taskContext.ctx?.run?.rootTaskRunId;
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
