import type { ApiClient } from "../apiClient/index.js";
import type { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import type { AnyZodFetchOptions } from "../zodfetch.js";
import { StreamsWriterV1 } from "./streamsWriterV1.js";
import { StreamsWriterV2 } from "./streamsWriterV2.js";
import type { StreamsWriter, StreamWriteResult } from "./types.js";

export type CreateStreamResponseLike = {
  version: string;
  headers?: Record<string, string>;
};

export type StreamInstanceOptions<T> = {
  apiClient: ApiClient;
  baseUrl: string;
  runId: string;
  key: string;
  source: ReadableStream<T>;
  signal?: AbortSignal;
  requestOptions?: AnyZodFetchOptions;
  target?: "self" | "parent" | "root" | string;
  debug?: boolean;
  /**
   * Optional override for the create-stream call. Defaults to
   * `apiClient.createStream(runId, "self", key, requestOptions)`. The
   * manager passes a cached version so repeated `pipe()` calls for the
   * same `(runId, key)` share a single PUT instead of hammering the
   * server on every chunk.
   */
  createStream?: () => Promise<CreateStreamResponseLike>;
};

type StreamsWriterInstance<T> = StreamsWriterV1<T> | StreamsWriterV2<T>;

export class StreamInstance<T> implements StreamsWriter {
  private streamPromise: Promise<StreamsWriterInstance<T>>;

  constructor(private options: StreamInstanceOptions<T>) {
    this.streamPromise = this.initializeWriter();
  }

  private async initializeWriter(): Promise<StreamsWriterInstance<T>> {
    const createStreamFn =
      this.options.createStream ??
      (() =>
        this.options.apiClient.createStream(
          this.options.runId,
          "self",
          this.options.key,
          this.options?.requestOptions
        ));

    const { version, headers } = await createStreamFn();

    const parsedResponse = parseCreateStreamResponse(version, headers);

    const streamWriter =
      parsedResponse.version === "v1"
        ? new StreamsWriterV1({
            key: this.options.key,
            runId: this.options.runId,
            source: this.options.source,
            baseUrl: this.options.baseUrl,
            headers: this.options.apiClient.getHeaders(),
            signal: this.options.signal,
            version,
            target: "self",
          })
        : new StreamsWriterV2({
            basin: parsedResponse.basin,
            stream: parsedResponse.streamName ?? this.options.key,
            accessToken: parsedResponse.accessToken,
            endpoint: parsedResponse.endpoint,
            source: this.options.source,
            signal: this.options.signal,
            debug: this.options.debug,
            flushIntervalMs: parsedResponse.flushIntervalMs,
            maxRetries: parsedResponse.maxRetries,
          });

    return streamWriter;
  }

  public async wait(): Promise<StreamWriteResult> {
    const writer = await this.streamPromise;
    return writer.wait();
  }

  public get stream(): AsyncIterableStream<T> {
    // eslint-disable-next-line no-this-alias
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

type ParsedStreamResponse =
  | {
      version: "v1";
    }
  | {
      version: "v2";
      accessToken: string;
      basin: string;
      endpoint?: string;
      flushIntervalMs?: number;
      maxRetries?: number;
      streamName?: string;
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

  const endpoint = headers?.["x-s2-endpoint"];
  const flushIntervalMs = headers?.["x-s2-flush-interval-ms"];
  const maxRetries = headers?.["x-s2-max-retries"];
  const streamName = headers?.["x-s2-stream-name"];

  return {
    version: "v2",
    accessToken,
    basin,
    endpoint,
    flushIntervalMs: flushIntervalMs ? parseInt(flushIntervalMs) : undefined,
    maxRetries: maxRetries ? parseInt(maxRetries) : undefined,
    streamName,
  };
}