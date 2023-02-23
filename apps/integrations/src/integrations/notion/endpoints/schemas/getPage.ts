import { JSONSchema } from "core/schemas/types";
import {
  PageObjectResponseSchema,
  PartialPageObjectResponseSchema,
} from "./page";
import { IdRequestSchema } from "./primitives";
import {
  PropertyItemListResponseSchema,
  PropertyItemObjectResponseSchema,
} from "./properties";

export const GetPagePathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    page_id: IdRequestSchema,
  },
  required: ["page_id"],
  additionalProperties: false,
};

export const GetPageQueryParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    filter_properties: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
  additionalProperties: false,
};

export const GetPageParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filter_properties: {
      type: "array",
      items: {
        type: "string",
      },
    },
    page_id: IdRequestSchema,
  },
  required: ["page_id"],
};

export const GetPageResponseSchema: JSONSchema = {
  anyOf: [PageObjectResponseSchema, PartialPageObjectResponseSchema],
};

export const GetPagePropertyPathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    page_id: IdRequestSchema,
    property_id: {
      type: "string",
    },
  },
  required: ["page_id", "property_id"],
  additionalProperties: false,
};

export const GetPagePropertyQueryParametersSchema: JSONSchema = {
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

export const GetPagePropertyParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
    page_id: IdRequestSchema,
    property_id: {
      type: "string",
    },
  },
  required: ["page_id", "property_id"],
};

export const GetPagePropertyResponseSchema: JSONSchema = {
  anyOf: [PropertyItemObjectResponseSchema, PropertyItemListResponseSchema],
};
