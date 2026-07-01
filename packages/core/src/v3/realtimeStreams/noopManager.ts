import type { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { createAsyncIterableStreamFromAsyncIterable } from "../streams/asyncIterableStream.js";
import type {
  RealtimeStreamOperationOptions,
  RealtimeStreamInstance,
  RealtimeStreamsManager,
} from "./types.js";

export class NoopRealtimeStreamsManager implements RealtimeStreamsManager {
  public pipe<T>(
    _key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    _options?: RealtimeStreamOperationOptions
  ): RealtimeStreamInstance<T> {
    return {
      wait: () => Promise.resolve({}),
      get stream(): AsyncIterableStream<T> {
        return createAsyncIterableStreamFromAsyncIterable(source);
      },
    };
  }

  public async append<TPart extends BodyInit>(
    _key: string,
    _part: TPart,
    _options?: RealtimeStreamOperationOptions
  ): Promise<void> {}
}
