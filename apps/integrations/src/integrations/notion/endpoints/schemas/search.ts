import { JSONSchema } from "core/schemas/types";
import {
  PartialDatabaseObjectResponseSchema,
  DatabaseObjectResponseSchema,
} from "./database";
import {
  PageObjectResponseSchema,
  PartialPageObjectResponseSchema,
} from "./page";
import { EmptyObjectSchema } from "./primitives";

export const SearchBodyParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    sort: {
      type: "object",
      properties: {
        timestamp: {
          type: "string",
          const: "last_edited_time",
        },
        direction: {
          type: "string",
          enum: ["ascending", "descending"],
        },
      },
      required: ["timestamp", "direction"],
      additionalProperties: false,
    },
    query: {
      type: "string",
    },
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
    filter: {
      type: "object",
      properties: {
        property: {
          type: "string",
          const: "object",
        },
        value: {
          type: "string",
          enum: ["page", "database"],
        },
      },
      required: ["property", "value"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const SearchParametersSchema: JSONSchema = SearchBodyParametersSchema;

export const SearchResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "page_or_database",
    },
    page_or_database: EmptyObjectSchema,
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
          PageObjectResponseSchema,
          PartialPageObjectResponseSchema,
          PartialDatabaseObjectResponseSchema,
          DatabaseObjectResponseSchema,
        ],
      },
    },
  },
  required: [
    "type",
    "page_or_database",
    "object",
    "next_cursor",
    "has_more",
    "results",
  ],
  additionalProperties: false,
};
