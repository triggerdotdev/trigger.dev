import { JSONSchema } from "core/schemas/types";
import { BlockObjectRequestSchema } from "./blockResponseSchema";
import {
  PartialBlockObjectResponseSchema,
  BlockObjectResponseSchema,
} from "./blocks";
import { IdRequestSchema, EmptyObjectSchema } from "./primitives";

export const AppendBlockChildrenPathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequestSchema,
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const AppendBlockChildrenBodyParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    children: {
      type: "array",
      items: BlockObjectRequestSchema,
    },
  },
  required: ["children"],
  additionalProperties: false,
};

export const AppendBlockChildrenParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    children: {
      type: "array",
      items: BlockObjectRequestSchema,
    },
    block_id: IdRequestSchema,
  },
  required: ["block_id", "children"],
};

export const AppendBlockChildrenResponseSchema: JSONSchema = {
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
