import { z } from "zod";
import { SerializableJsonSchema } from "./json";

export const KVGetSchema = z.object({
  key: z.string(),
  namespace: z.string(),
});

export type KVGetOperation = z.infer<typeof KVGetSchema>;

export const KVDeleteSchema = z.object({
  key: z.string(),
  namespace: z.string(),
});

export type KVDeleteOperation = z.infer<typeof KVDeleteSchema>;

export const KVSetSchema = z.object({
  key: z.string(),
  namespace: z.string(),
  value: SerializableJsonSchema,
});

export type KVSetOperation = z.infer<typeof KVSetSchema>;
