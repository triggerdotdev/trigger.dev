import { ApiClient } from "../apiClient/index.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { AnyZodFetchOptions } from "../zodfetch.js";
import { StreamsWriterV2 } from "./streamsWriterV2.js";
import { StreamsWriter, StreamWriteResult } from "./types.js";

export type SessionStreamInstanceOptions<T> = {
  apiClient: ApiClient;
  baseUrl: string;
  sessionId: string;
  io: "out" | "in";
  source: ReadableStream<T>;
  signal?: AbortSignal;
  requestOptions?: AnyZodFetchOptions;
  debug?: boolean;
};

/**
 * Session-scoped parallel to {@link StreamInstance}. Calls
 * `initializeSessionStream` to fetch S2 credentials for the session's
 * channel, then pipes `source` directly to S2 via {@link StreamsWriterV2}.
 *
 * Sessions are S2-only — there's no v1 (Redis) fallback — so this
 * skips the version-detection dance `StreamInstance` does.
 */
export class SessionStreamInstance<T> implements StreamsWriter {
  private streamPromise: Promise<StreamsWriterV2<T>>;

  constructor(private options: SessionStreamInstanceOptions<T>) {
    this.streamPromise = this.initializeWriter();
  }

  private async initializeWriter(): Promise<StreamsWriterV2<T>> {
    const response = await this.options.apiClient.initializeSessionStream(
      this.options.sessionId,
      this.options.io,
      this.options?.requestOptions
    );

    const headers = response.headers ?? {};
    const accessToken = headers["x-s2-access-token"];
    const basin = headers["x-s2-basin"];
    const streamName = headers["x-s2-stream-name"];
    const endpoint = headers["x-s2-endpoint"];
    const flushIntervalMs = headers["x-s2-flush-interval-ms"]
      ? parseInt(headers["x-s2-flush-interval-ms"])
      : undefined;
    const maxRetries = headers["x-s2-max-retries"]
      ? parseInt(headers["x-s2-max-retries"])
      : undefined;

    if (!accessToken || !basin || !streamName) {
      throw new Error(
        "Session stream initialize did not return S2 credentials — server may be configured for v1 realtime streams, which sessions do not support."
      );
    }

    return new StreamsWriterV2({
      basin,
      stream: streamName,
      accessToken,
      endpoint,
      source: this.options.source,
      signal: this.options.signal,
      debug: this.options.debug,
      flushIntervalMs,
      maxRetries,
    });
  }

  public async wait(): Promise<StreamWriteResult> {
    const writer = await this.streamPromise;
    return writer.wait();
  }

  public get stream(): AsyncIterableStream<T> {
    const self = this;

    return new ReadableStream<T>({
      async start(controller) {
        const streamWriter = await self.streamPromise;

        const iterator = streamWriter[Symbol.asyncIterator]();

        while (true) {
          if (self.options.signal?.aborted) {
            controller.close();
            break;
          }

          const { done, value } = await iterator.next();

          if (done) {
            controller.close();
            break;
          }

          controller.enqueue(value);
        }
      },
    });
  }
}
