import { JSONSchema } from "core/schemas/types";

export const GetPagePropertyPathParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "page_id": IdRequest,
    "property_id": {
      "type": "string"
    }
  },
  "required": [
    "page_id",
    "property_id"
  ],
  "additionalProperties": false
};

export const GetPagePropertyQueryParameters: JSONSchema = {
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

export const GetPagePropertyParameters: JSONSchema = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "start_cursor": {
      "type": "string"
    },
    "page_size": {
      "type": "number"
    },
    "page_id": IdRequest,
    "property_id": {
      "type": "string"
    }
  },
  "required": [
    "page_id",
    "property_id"
  ]
};

export const GetPagePropertyResponse: JSONSchema = {
  "anyOf": [
    PropertyItemObjectResponse,
    PropertyItemListResponse
  ]
};