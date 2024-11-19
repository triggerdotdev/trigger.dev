import { z } from "zod";
import { ApiError } from "./errors.js";

export type ZodShapeStreamOptions = {
  headers?: Record<string, string>;
  fetchClient?: typeof fetch;
  signal?: AbortSignal;
};

export async function zodShapeStream<TShapeSchema extends z.ZodTypeAny>(
  schema: TShapeSchema,
  url: string,
  callback: (shape: z.output<TShapeSchema>) => void | Promise<void>,
  options?: ZodShapeStreamOptions
) {
  const { ShapeStream, Shape, FetchError } = await import("@electric-sql/client");

  const stream = new ShapeStream<z.input<TShapeSchema>>({
    url,
    headers: {
      ...options?.headers,
      "x-trigger-electric-version": "0.8.1",
    },
    fetchClient: options?.fetchClient,
    signal: options?.signal,
  });

  try {
    const shape = new Shape(stream);

    const initialRows = await shape.rows;

    for (const shapeRow of initialRows) {
      await callback(schema.parse(shapeRow));
    }

    return shape.subscribe(async (newShape) => {
      for (const shapeRow of newShape.rows) {
        await callback(schema.parse(shapeRow));
      }
    });
  } catch (error) {
    if (error instanceof FetchError) {
      throw ApiError.generate(error.status, error.json, error.message, error.headers);
    } else {
      throw error;
    }
  }
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
