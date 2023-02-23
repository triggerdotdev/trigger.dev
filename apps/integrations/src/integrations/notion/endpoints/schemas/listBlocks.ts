import { JSONSchema } from "core/schemas/types";
import {
  PartialBlockObjectResponseSchema,
  BlockObjectResponseSchema,
} from "./blocks";
import { IdRequestSchema, EmptyObjectSchema } from "./primitives";

export const ListBlockChildrenPathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequestSchema,
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const ListBlockChildrenQueryParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
  },
  additionalProperties: false,
};

export const ListBlockChildrenParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
    block_id: IdRequestSchema,
  },
  required: ["block_id"],
};

export const ListBlockChildrenResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "block",
    },
    block: EmptyObjectSchema,
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
      items: {
        anyOf: [PartialBlockObjectResponseSchema, BlockObjectResponseSchema],
      },
    },
  },
  required: ["type", "block", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
