import { JSONSchema } from "core/schemas/types";
import { EmptyObject } from "../common";
import {
  DatabaseObjectResponse,
  PartialDatabaseObjectResponse,
} from "../database";

export const ListDatabasesQueryParameters: JSONSchema = {
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

export const ListDatabasesParameters: JSONSchema = ListDatabasesQueryParameters;

export const ListDatabasesResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "database",
    },
    database: EmptyObject,
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
        anyOf: [PartialDatabaseObjectResponse, DatabaseObjectResponse],
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
