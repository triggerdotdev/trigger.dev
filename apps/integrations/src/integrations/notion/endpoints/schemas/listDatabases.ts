import { JSONSchema } from "core/schemas/types";
import {
  PartialDatabaseObjectResponseSchema,
  DatabaseObjectResponseSchema,
} from "./database";
import { EmptyObjectSchema } from "./primitives";

export const ListDatabasesQueryParametersSchema: JSONSchema = {
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

export const ListDatabasesParametersSchema: JSONSchema =
  ListDatabasesQueryParametersSchema;

export const ListDatabasesResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "database",
    },
    database: EmptyObjectSchema,
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
        anyOf: [
          PartialDatabaseObjectResponseSchema,
          DatabaseObjectResponseSchema,
        ],
      },
    },
  },
  required: [
    "type",
    "database",
    "object",
    "next_cursor",
    "has_more",
    "results",
  ],
  additionalProperties: false,
};
