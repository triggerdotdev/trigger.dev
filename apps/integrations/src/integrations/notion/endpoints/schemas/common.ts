import { JSONSchema } from "core/schemas/types";

export const IdRequest: JSONSchema = {
  "type": [
    "string"
  ]
};

export const NeverRecord: JSONSchema = {
  "type": "object",
  "additionalProperties": {
    "not": {}
  }
};

export const EmptyObject: JSONSchema = NeverRecord;

export const StringRequest: JSONSchema = {
  "type": "string"
};

export const SelectColor: JSONSchema = {
  "type": "string",
  "enum": [
    "default",
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red"
  ]
};

export const ApiColor: JSONSchema = {
  "type": "string",
  "enum": [
    "default",
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red",
    "gray_background",
    "brown_background",
    "orange_background",
    "yellow_background",
    "green_background",
    "blue_background",
    "purple_background",
    "pink_background",
    "red_background"
  ]
};