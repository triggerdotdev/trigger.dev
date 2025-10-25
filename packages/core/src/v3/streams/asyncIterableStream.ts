export type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

export function createAsyncIterableStream<S, T>(
  source: ReadableStream<S>,
  transformer: Transformer<S, T>
): AsyncIterableStream<T> {
  const transformedStream: any = source.pipeThrough(new TransformStream(transformer));

  transformedStream[Symbol.asyncIterator] = () => {
    const reader = transformedStream.getReader();
    return {
      async next(): Promise<IteratorResult<string>> {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
    };
  };

  return transformedStream;
}

export function createAsyncIterableReadable<S, T>(
  source: ReadableStream<S>,
  transformer: Transformer<S, T>,
  signal: AbortSignal
): AsyncIterableStream<T> {
  return new ReadableStream<T>({
    async start(controller) {
      const transformedStream = source.pipeThrough(new TransformStream(transformer));
      const reader = transformedStream.getReader();

      signal.addEventListener("abort", () => {
        queueMicrotask(() => {
          reader.cancel();
          controller.close();
        });
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          break;
        }

        controller.enqueue(value);
      }
    },
  }) as AsyncIterableStream<T>;
}

export function createAsyncIterableStreamFromAsyncIterable<T>(
  asyncIterable: AsyncIterable<T>,
  transformer?: Transformer<T, T>,
  signal?: AbortSignal
): AsyncIterableStream<T> {
  const stream = new ReadableStream<T>({
    async start(controller) {
      try {
        if (signal) {
          signal.addEventListener("abort", () => {
            controller.close();
          });
        }

        const iterator = asyncIterable[Symbol.asyncIterator]();

        while (true) {
          if (signal?.aborted) {
            break;
          }

          const { done, value } = await iterator.next();

          if (done) {
            controller.close();
            break;
          }

          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      // If the stream is a tinyexec process with a kill method, kill it
      if ("kill" in asyncIterable) {
        (asyncIterable as any).kill();
      }
    },
  });

  const transformedStream = stream.pipeThrough(new TransformStream(transformer));

  return transformedStream as AsyncIterableStream<T>;
}

export function createAsyncIterableStreamFromAsyncGenerator<T>(
  asyncGenerator: AsyncGenerator<T, void, unknown>,
  transformer: Transformer<T, T>,
  signal?: AbortSignal
): AsyncIterableStream<T> {
  return createAsyncIterableStreamFromAsyncIterable(asyncGenerator, transformer, signal);
}

export function ensureAsyncIterable<T>(
  input: AsyncIterable<T> | ReadableStream<T>
): AsyncIterable<T> {
  // If it's already an AsyncIterable, return it as-is
  if (Symbol.asyncIterator in input) {
    return input as AsyncIterable<T>;
  }

  // Convert ReadableStream to AsyncIterable
  const readableStream = input as ReadableStream<T>;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = readableStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value !== undefined) {
            yield value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
