import { z } from "zod";

const LiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Literal = z.infer<typeof LiteralSchema>;

type Json = Literal | { [key: string]: Json } | Json[];

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([LiteralSchema, z.array(JsonSchema), z.record(JsonSchema)])
);

const SerializableSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.date(),
]);
type Serializable = z.infer<typeof SerializableSchema>;

type SerializableJson =
  | Serializable
  | { [key: string]: SerializableJson }
  | SerializableJson[];

export const SerializableJsonSchema: z.ZodType<SerializableJson> = z.lazy(() =>
  z.union([
    SerializableSchema,
    z.array(SerializableJsonSchema),
    z.record(SerializableJsonSchema),
  ])
);
