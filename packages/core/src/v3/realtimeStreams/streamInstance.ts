import { ApiClient } from "../apiClient/index.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { AnyZodFetchOptions } from "../zodfetch.js";
import { StreamsWriterV1 } from "./streamsWriterV1.js";
import { StreamsWriterV2 } from "./streamsWriterV2.js";
import { StreamsWriter } from "./types.js";

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
};

type StreamsWriterInstance<T> = StreamsWriterV1<T> | StreamsWriterV2<T>;

export class StreamInstance<T> implements StreamsWriter {
  private streamPromise: Promise<StreamsWriterInstance<T>>;

  constructor(private options: StreamInstanceOptions<T>) {
    this.streamPromise = this.initializeWriter();
  }

  private async initializeWriter(): Promise<StreamsWriterInstance<T>> {
    const { version, headers } = await this.options.apiClient.createStream(
      this.options.runId,
      "self",
      this.options.key,
      this.options?.requestOptions
    );

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
            stream: this.options.key,
            accessToken: parsedResponse.accessToken,
            source: this.options.source,
            signal: this.options.signal,
            debug: this.options.debug,
            flushIntervalMs: parsedResponse.flushIntervalMs,
            maxRetries: parsedResponse.maxRetries,
          });

    return streamWriter;
  }

  public async wait(): Promise<void> {
    return this.streamPromise.then((writer) => writer.wait());
  }

  public get stream(): AsyncIterableStream<T> {
    const self = this;

    return new ReadableStream<T>({
      async start(controller) {
        const streamWriter = await self.streamPromise;

        const iterator = streamWriter[Symbol.asyncIterator]();

        while (true) {
          if (self.options.signal?.aborted) {
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

async function* streamToAsyncIterator<T>(stream: ReadableStream<T>): AsyncIterableIterator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    safeReleaseLock(reader);
  }
}

function safeReleaseLock(reader: ReadableStreamDefaultReader<any>) {
  try {
    reader.releaseLock();
  } catch (error) {}
}
