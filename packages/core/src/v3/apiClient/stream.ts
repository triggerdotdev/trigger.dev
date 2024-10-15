import { z } from "zod";

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
  const { ShapeStream, Shape } = await import("@electric-sql/client");

  const stream = new ShapeStream<z.input<TShapeSchema>>({
    url,
    headers: options?.headers,
    fetchClient: options?.fetchClient,
    signal: options?.signal,
  });

  const shape = new Shape(stream);

  const initialValue = await shape.value;

  for (const shapeRow of initialValue.values()) {
    await callback(schema.parse(shapeRow));
  }

  return shape.subscribe(async (newShape) => {
    for (const shapeRow of newShape.values()) {
      await callback(schema.parse(shapeRow));
    }
  });
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
