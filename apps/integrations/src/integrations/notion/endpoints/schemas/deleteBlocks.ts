import { JSONSchema } from "core/schemas/types";
import {
  PartialBlockObjectResponseSchema,
  BlockObjectResponseSchema,
} from "./blocks";
import { IdRequestSchema } from "./primitives";

export const DeleteBlockPathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequestSchema,
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const DeleteBlockParametersSchema: JSONSchema =
  DeleteBlockPathParametersSchema;

export const DeleteBlockResponseSchema: JSONSchema = {
  anyOf: [PartialBlockObjectResponseSchema, BlockObjectResponseSchema],
};
