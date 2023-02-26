import { JSONSchema } from "core/schemas/types";

export const GetPagePathParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "page_id": IdRequest
  },
  "required": [
    "page_id"
  ],
  "additionalProperties": false
};

export const GetPageQueryParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "filter_properties": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "additionalProperties": false
};

export const GetPageParameters: JSONSchema = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "filter_properties": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "page_id": IdRequest
  },
  "required": [
    "page_id"
  ]
};

export const GetPageResponse: JSONSchema = {
  "anyOf": [
    PageObjectResponse,
    PartialPageObjectResponse
  ]
};