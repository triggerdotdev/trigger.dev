import { JSONSchema } from "core/schemas/types";
import { BlockObjectRequest } from "../blockRequests";
import {
  PartialBlockObjectResponse,
  BlockObjectResponse,
} from "../blockResponses";
import { EmptyObject, IdRequest } from "../common";

export const AppendBlockChildrenPathParameters: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequest,
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const AppendBlockChildrenBodyParameters: JSONSchema = {
  type: "object",
  properties: {
    children: {
      type: "array",
      items: BlockObjectRequest,
    },
  },
  required: ["children"],
  additionalProperties: false,
};

export const AppendBlockChildrenParameters: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    children: {
      type: "array",
      items: BlockObjectRequest,
    },
    block_id: IdRequest,
  },
  required: ["block_id", "children"],
};

export const AppendBlockChildrenResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "block",
    },
    block: EmptyObject,
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
        anyOf: [PartialBlockObjectResponse, BlockObjectResponse],
      },
    },
  },
  required: ["type", "block", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
