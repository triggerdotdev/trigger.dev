import { JSONSchema } from "core/schemas/types";
import { IdRequestSchema, EmptyObjectSchema } from "./primitives";
import { CommentObjectResponseSchema } from "./properties";

export const ListCommentsQueryParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequestSchema,
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const ListCommentsParametersSchema: JSONSchema =
  ListCommentsQueryParametersSchema;

export const ListCommentsResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "comment",
    },
    comment: EmptyObjectSchema,
    object: {
      type: "string",
      const: "list",
    },
    next_cursor: {
      type: ["string", "null"],
    },
    has_more: {
      type: "boolean",
    },
    results: {
      type: "array",
      items: CommentObjectResponseSchema,
    },
  },
  required: ["type", "comment", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
