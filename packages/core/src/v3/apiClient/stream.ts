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
  // @ts-ignore it's safe to import types from the client
} from "@electric-sql/client";

export type ZodShapeStreamOptions = {
  headers?: Record<string, string>;
  fetchClient?: typeof fetch;
  signal?: AbortSignal;
};

export function zodShapeStream<TShapeSchema extends z.ZodTypeAny>(
  schema: TShapeSchema,
  url: string,
  options?: ZodShapeStreamOptions
) {
  const stream = new ShapeStream<z.input<TShapeSchema>>({
    url,
    headers: {
      ...options?.headers,
      "x-trigger-electric-version": "0.8.1",
    },
    fetchClient: options?.fetchClient,
    signal: options?.signal,
  });

  const readableShape = new ReadableShapeStream(stream);

  return readableShape.stream.pipeThrough(
    new TransformStream({
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

  constructor(stream: ShapeStreamInterface<T>) {
    this.#stream = stream;

    // Create the source stream that will receive messages
    const source = new ReadableStream<Message<T>[]>({
      start: (controller) => {
        this.#stream.subscribe(
          (messages) => controller.enqueue(messages),
          this.#handleError.bind(this)
        );
      },
    });

    // Create the transformed stream that processes messages and emits complete rows
    this.#changeStream = createAsyncIterableStream(source, {
      transform: (messages, controller) => {
        messages.forEach((message) => {
          if (isChangeMessage(message)) {
            switch (message.headers.operation) {
              case "insert": {
                this.#currentState.set(message.key, message.value);
                controller.enqueue(message.value);
                break;
              }
              case "update": {
                const existingRow = this.#currentState.get(message.key);
                if (existingRow) {
                  const updatedRow = {
                    ...existingRow,
                    ...message.value,
                  };
                  this.#currentState.set(message.key, updatedRow);
                  controller.enqueue(updatedRow);
                } else {
                  this.#currentState.set(message.key, message.value);
                  controller.enqueue(message.value);
                }
                break;
              }
            }
          }

          if (isControlMessage(message)) {
            switch (message.headers.control) {
              case "must-refetch":
                this.#currentState.clear();
                this.#error = false;
                break;
            }
          }
        });
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

  constructor(streamId: string) {
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

        console.log("LineTransformStream", {
          chunk,
          lines,
          fullLines,
          buffer: this.buffer,
          streamId,
        });

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
