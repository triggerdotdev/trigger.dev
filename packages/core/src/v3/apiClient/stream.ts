import { z } from "zod";

export type ZodShapeStreamOptions = {
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
