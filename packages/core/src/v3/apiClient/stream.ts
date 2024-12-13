import { z } from "zod";
import {
  FetchError,
  isChangeMessage,
  isControlMessage,
  Offset,
  ShapeStream,
  type Message,
  type Row,
  type ShapeStreamInterface,
} from "@electric-sql/client";

export type ZodShapeStreamOptions = {
  headers?: Record<string, string>;
  fetchClient?: typeof fetch;
  signal?: AbortSignal;
};

export type ZodShapeStreamInstance<TShapeSchema extends z.ZodTypeAny> = {
  stream: AsyncIterableStream<z.output<TShapeSchema>>;
  stop: () => void;
};

export function zodShapeStream<TShapeSchema extends z.ZodTypeAny>(
  schema: TShapeSchema,
  url: string,
  options?: ZodShapeStreamOptions
): ZodShapeStreamInstance<TShapeSchema> {
  const abortController = new AbortController();

  options?.signal?.addEventListener(
    "abort",
    () => {
      abortController.abort();
    },
    { once: true }
  );

  const shapeStream = new ShapeStream({
    url,
    headers: {
      ...options?.headers,
      "x-trigger-electric-version": "1.0.0-beta.1",
    },
    fetchClient: options?.fetchClient,
    signal: abortController.signal,
  });

  const readableShape = new ReadableShapeStream(shapeStream);

  const stream = readableShape.stream.pipeThrough(
    new TransformStream<unknown, z.output<TShapeSchema>>({
      async transform(chunk, controller) {
        const result = schema.safeParse(chunk);

        if (result.success) {
          controller.enqueue(result.data);
        } else {
          controller.error(new Error(`Unable to parse shape: ${result.error.message}`));
        }
      },
    })
  );

  return {
    stream: stream as AsyncIterableStream<z.output<TShapeSchema>>,
    stop: () => {
      console.log("Stopping zodShapeStream with abortController.abort()");
      abortController.abort();
    },
  };
}

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

class ReadableShapeStream<T extends Row<unknown> = Row> {
  readonly #stream: ShapeStreamInterface<T>;
  readonly #currentState: Map<string, T> = new Map();
  readonly #changeStream: AsyncIterableStream<T>;
  #error: FetchError | false = false;
  #unsubscribe?: () => void;

  stop() {
    this.#unsubscribe?.();
  }

  constructor(stream: ShapeStreamInterface<T>) {
    this.#stream = stream;

    // Create the source stream that will receive messages
    const source = new ReadableStream<Message<T>[]>({
      start: (controller) => {
        this.#unsubscribe = this.#stream.subscribe(
          (messages) => controller.enqueue(messages),
          this.#handleError.bind(this)
        );
      },
    });

    // Create the transformed stream that processes messages and emits complete rows
    this.#changeStream = createAsyncIterableStream(source, {
      transform: (messages, controller) => {
        const updatedKeys = new Set<string>();

        for (const message of messages) {
          if (isChangeMessage(message)) {
            const key = message.key;
            switch (message.headers.operation) {
              case "insert": {
                // New row entirely
                this.#currentState.set(key, message.value);
                updatedKeys.add(key);
                break;
              }
              case "update": {
                // Merge updates into existing row if any, otherwise treat as new
                const existingRow = this.#currentState.get(key);
                const updatedRow = existingRow
                  ? { ...existingRow, ...message.value }
                  : message.value;
                this.#currentState.set(key, updatedRow);
                updatedKeys.add(key);
                break;
              }
            }
          } else if (isControlMessage(message)) {
            if (message.headers.control === "must-refetch") {
              this.#currentState.clear();
              this.#error = false;
            }
          }
        }

        // Now enqueue only one updated row per key, after all messages have been processed.
        for (const key of updatedKeys) {
          const finalRow = this.#currentState.get(key);
          if (finalRow) {
            controller.enqueue(finalRow);
          }
        }
      },
    });
  }

  get stream(): AsyncIterableStream<T> {
    return this.#changeStream;
  }

  get isUpToDate(): boolean {
    return this.#stream.isUpToDate;
  }

  get lastOffset(): Offset {
    return this.#stream.lastOffset;
  }

  get handle(): string | undefined {
    return this.#stream.shapeHandle;
  }

  get error() {
    return this.#error;
  }

  lastSyncedAt(): number | undefined {
    return this.#stream.lastSyncedAt();
  }

  lastSynced() {
    return this.#stream.lastSynced();
  }

  isLoading() {
    return this.#stream.isLoading();
  }

  isConnected(): boolean {
    return this.#stream.isConnected();
  }

  #handleError(e: Error): void {
    if (e instanceof FetchError) {
      this.#error = e;
    }
  }
}

export class LineTransformStream extends TransformStream<string, string[]> {
  private buffer = "";

  constructor() {
    super({
      transform: (chunk, controller) => {
        // Append the chunk to the buffer
        this.buffer += chunk;

        // Split on newlines
        const lines = this.buffer.split("\n");

        // The last element might be incomplete, hold it back in buffer
        this.buffer = lines.pop() || "";

        // Filter out empty or whitespace-only lines
        const fullLines = lines.filter((line) => line.trim().length > 0);

        // If we got any complete lines, emit them as an array
        if (fullLines.length > 0) {
          controller.enqueue(fullLines);
        }
      },
      flush: (controller) => {
        // On stream end, if there's leftover text, emit it as a single-element array
        const trimmed = this.buffer.trim();
        if (trimmed.length > 0) {
          controller.enqueue([trimmed]);
        }
      },
    });
  }
}
