import { JSONSchema } from "core/schemas/types";

export const ListCommentsQueryParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "block_id": IdRequest,
    "start_cursor": {
      "type": "string"
    },
    "page_size": {
      "type": "number"
    }
  },
  "required": [
    "block_id"
  ],
  "additionalProperties": false
};

export const ListCommentsParameters: JSONSchema = ListCommentsQueryParameters;

export const ListCommentsResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "comment"
    },
    "comment": EmptyObject,
    "object": {
      "type": "string",
      "const": "list"
    },
    "next_cursor": {
      "type": [
        "string",
        "null"
      ]
    },
    "has_more": {
      "type": "boolean"
    },
    "results": {
      "type": "array",
      "items": CommentObjectResponse
    }
  },
  "required": [
    "type",
    "comment",
    "object",
    "next_cursor",
    "has_more",
    "results"
  ],
  "additionalProperties": false
};
