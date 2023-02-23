import { JSONSchema } from "core/schemas/types";
import {
  PartialBlockObjectResponseSchema,
  BlockObjectResponseSchema,
} from "./blocks";
import { IdRequestSchema } from "./primitives";

export const GetBlockPathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequestSchema,
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const GetBlockParametersSchema: JSONSchema =
  GetBlockPathParametersSchema;

export const GetBlockResponseSchema: JSONSchema = {
  anyOf: [PartialBlockObjectResponseSchema, BlockObjectResponseSchema],
};
