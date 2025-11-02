import {
  AsyncIterableStream,
  createAsyncIterableStreamFromAsyncIterable,
} from "../streams/asyncIterableStream.js";
import {
  RealtimePipeStreamOptions,
  RealtimeStreamInstance,
  RealtimeStreamsManager,
} from "./types.js";

export class NoopRealtimeStreamsManager implements RealtimeStreamsManager {
  public pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimePipeStreamOptions
  ): RealtimeStreamInstance<T> {
    return {
      wait: () => Promise.resolve(),
      get stream(): AsyncIterableStream<T> {
        return createAsyncIterableStreamFromAsyncIterable(source);
      },
    };
  }
}
