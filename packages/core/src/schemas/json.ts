import { z } from "zod";

const LiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Literal = z.infer<typeof LiteralSchema>;

export type DeserializedJson = Literal | { [key: string]: DeserializedJson } | DeserializedJson[];

export const DeserializedJsonSchema: z.ZodType<DeserializedJson> = z.lazy(() =>
  z.union([LiteralSchema, z.array(DeserializedJsonSchema), z.record(DeserializedJsonSchema)])
);

const SerializableSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.date(),
  z.undefined(),
  z.symbol(),
]);
type Serializable = z.infer<typeof SerializableSchema>;

export type SerializableJson =
  | Serializable
  | { [key: string]: SerializableJson }
  | SerializableJson[];

export const SerializableJsonSchema: z.ZodType<SerializableJson> = z.lazy(() =>
  z.union([SerializableSchema, z.array(SerializableJsonSchema), z.record(SerializableJsonSchema)])
);

/** Useful for stripping out [key: string] indexes from objects, to get them to be SerializableJson compatible */
export type OmitIndexSignature<T> = {
  [K in keyof T as string extends K ? never : K]: OmitIndexSignature<T[K]>;
};
