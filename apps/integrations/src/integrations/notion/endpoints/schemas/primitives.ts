import { JSONSchema } from "core/schemas/types";

export const IdRequestSchema: JSONSchema = {
  type: ["string"],
};

export const NeverRecordSchema: JSONSchema = {
  type: "object",
  additionalProperties: {
    not: {},
  },
};

export const EmptyObjectSchema: JSONSchema = NeverRecordSchema;

export const StringRequestSchema: JSONSchema = {
  type: "string",
};
