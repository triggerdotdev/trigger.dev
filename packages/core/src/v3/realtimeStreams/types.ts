import { AnyZodFetchOptions } from "../apiClient/core.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";

export type RealtimeAppendStreamOptions = {
  signal?: AbortSignal;
  target?: string;
  requestOptions?: AnyZodFetchOptions;
};

export interface RealtimeStreamsManager {
  append<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimeAppendStreamOptions
  ): Promise<RealtimeStreamInstance<T>>;
}

export interface RealtimeStreamInstance<T> {
  wait(): Promise<void>;
  get stream(): AsyncIterableStream<T>;
}
