import { JSONSchema } from "core/schemas/types";

export const ListBlockChildrenPathParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "block_id": IdRequest
  },
  "required": [
    "block_id"
  ],
  "additionalProperties": false
};

export const ListBlockChildrenQueryParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "start_cursor": {
      "type": "string"
    },
    "page_size": {
      "type": "number"
    }
  },
  "additionalProperties": false
};

export const ListBlockChildrenParameters: JSONSchema = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "start_cursor": {
      "type": "string"
    },
    "page_size": {
      "type": "number"
    },
    "block_id": IdRequest
  },
  "required": [
    "block_id"
  ]
};

export const ListBlockChildrenResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "block"
    },
    "block": EmptyObject,
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
      "items": {
        "anyOf": [
          PartialBlockObjectResponse,
          BlockObjectResponse
        ]
      }
    }
  },
  "required": [
    "type",
    "block",
    "object",
    "next_cursor",
    "has_more",
    "results"
  ],
  "additionalProperties": false
};