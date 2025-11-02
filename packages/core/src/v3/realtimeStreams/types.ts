import { AnyZodFetchOptions } from "../apiClient/core.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";

export type RealtimePipeStreamOptions = {
  signal?: AbortSignal;
  target?: string;
  requestOptions?: AnyZodFetchOptions;
};

export interface RealtimeStreamsManager {
  pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimePipeStreamOptions
  ): RealtimeStreamInstance<T>;
}

export interface RealtimeStreamInstance<T> {
  wait(): Promise<void>;
  get stream(): AsyncIterableStream<T>;
}

export interface StreamsWriter {
  wait(): Promise<void>;
}
