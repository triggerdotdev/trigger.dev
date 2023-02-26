import { JSONSchema } from "core/schemas/types";
import { EmptyObject } from "../common";
import { UserObjectResponse } from "../person";

export const ListUsersQueryParameters: JSONSchema = {
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

export const ListUsersParameters: JSONSchema = ListUsersQueryParameters;

export const ListUsersResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "user",
    },
    user: EmptyObject,
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
      items: UserObjectResponse,
    },
  },
  required: ["type", "user", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
