import {
  AsyncIterableStream,
  createAsyncIterableStreamFromAsyncIterable,
} from "../streams/asyncIterableStream.js";
import {
  RealtimeStreamOperationOptions,
  RealtimeStreamInstance,
  RealtimeStreamsManager,
} from "./types.js";

export class NoopRealtimeStreamsManager implements RealtimeStreamsManager {
  public pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimeStreamOperationOptions
  ): RealtimeStreamInstance<T> {
    return {
      wait: () => Promise.resolve(),
      get stream(): AsyncIterableStream<T> {
        return createAsyncIterableStreamFromAsyncIterable(source);
      },
    };
  }

  public async append<TPart extends BodyInit>(
    key: string,
    part: TPart,
    options?: RealtimeStreamOperationOptions
  ): Promise<void> {}
}
