import {
  AsyncIterableStream,
  createAsyncIterableStreamFromAsyncIterable,
} from "../streams/asyncIterableStream.js";
import {
  RealtimeAppendStreamOptions,
  RealtimeStreamInstance,
  RealtimeStreamsManager,
} from "./types.js";

export class NoopRealtimeStreamsManager implements RealtimeStreamsManager {
  public append<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimeAppendStreamOptions
  ): Promise<RealtimeStreamInstance<T>> {
    return Promise.resolve({
      wait: () => Promise.resolve(),
      get stream(): AsyncIterableStream<T> {
        return createAsyncIterableStreamFromAsyncIterable(source);
      },
    });
  }
}
