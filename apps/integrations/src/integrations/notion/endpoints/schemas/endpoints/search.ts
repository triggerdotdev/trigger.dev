import { JSONSchema } from "core/schemas/types";

export const SearchBodyParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "sort": {
      "type": "object",
      "properties": {
        "timestamp": {
          "type": "string",
          "const": "last_edited_time"
        },
        "direction": {
          "type": "string",
          "enum": [
            "ascending",
            "descending"
          ]
        }
      },
      "required": [
        "timestamp",
        "direction"
      ],
      "additionalProperties": false
    },
    "query": {
      "type": "string"
    },
    "start_cursor": {
      "type": "string"
    },
    "page_size": {
      "type": "number"
    },
    "filter": {
      "type": "object",
      "properties": {
        "property": {
          "type": "string",
          "const": "object"
        },
        "value": {
          "type": "string",
          "enum": [
            "page",
            "database"
          ]
        }
      },
      "required": [
        "property",
        "value"
      ],
      "additionalProperties": false
    }
  },
  "additionalProperties": false
};

export const SearchParameters: JSONSchema = SearchBodyParameters;

export const SearchResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "page_or_database"
    },
    "page_or_database": EmptyObject,
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
          PageObjectResponse,
          PartialPageObjectResponse,
          PartialDatabaseObjectResponse,
          DatabaseObjectResponse
        ]
      }
    }
  },
  "required": [
    "type",
    "page_or_database",
    "object",
    "next_cursor",
    "has_more",
    "results"
  ],
  "additionalProperties": false
};