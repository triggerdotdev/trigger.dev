import { JSONSchema } from "core/schemas/types";
import {
  PropertyFilterSchema,
  TimestampCreatedTimeFilterSchema,
  TimestampLastEditedTimeFilterSchema,
} from "./filters";
import {
  PageObjectResponseSchema,
  PartialPageObjectResponseSchema,
} from "./page";
import { IdRequestSchema, EmptyObjectSchema } from "./primitives";

export const QueryDatabasePathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    database_id: IdRequestSchema,
  },
  required: ["database_id"],
  additionalProperties: false,
};

export const QueryDatabaseQueryParametersSchema: JSONSchema = {
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

export const QueryDatabaseBodyParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    sorts: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              property: {
                type: "string",
              },
              direction: {
                type: "string",
                enum: ["ascending", "descending"],
              },
            },
            required: ["property", "direction"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              timestamp: {
                type: "string",
                enum: ["created_time", "last_edited_time"],
              },
              direction: {
                type: "string",
                enum: ["ascending", "descending"],
              },
            },
            required: ["timestamp", "direction"],
            additionalProperties: false,
          },
        ],
      },
    },
    filter: {
      anyOf: [
        {
          type: "object",
          properties: {
            or: {
              type: "array",
              items: {
                anyOf: [
                  PropertyFilterSchema,
                  TimestampCreatedTimeFilterSchema,
                  TimestampLastEditedTimeFilterSchema,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["or"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      and: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["and"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["or"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            and: {
              type: "array",
              items: {
                anyOf: [
                  PropertyFilterSchema,
                  TimestampCreatedTimeFilterSchema,
                  TimestampLastEditedTimeFilterSchema,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["or"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      and: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["and"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["and"],
          additionalProperties: false,
        },
        PropertyFilterSchema,
        TimestampCreatedTimeFilterSchema,
        TimestampLastEditedTimeFilterSchema,
      ],
    },
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
    archived: {
      type: "boolean",
    },
  },
  additionalProperties: false,
};

export const QueryDatabaseParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sorts: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              property: {
                type: "string",
              },
              direction: {
                type: "string",
                enum: ["ascending", "descending"],
              },
            },
            required: ["property", "direction"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              timestamp: {
                type: "string",
                enum: ["created_time", "last_edited_time"],
              },
              direction: {
                type: "string",
                enum: ["ascending", "descending"],
              },
            },
            required: ["timestamp", "direction"],
            additionalProperties: false,
          },
        ],
      },
    },
    filter: {
      anyOf: [
        {
          type: "object",
          properties: {
            or: {
              type: "array",
              items: {
                anyOf: [
                  PropertyFilterSchema,
                  TimestampCreatedTimeFilterSchema,
                  TimestampLastEditedTimeFilterSchema,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["or"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      and: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["and"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["or"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            and: {
              type: "array",
              items: {
                anyOf: [
                  PropertyFilterSchema,
                  TimestampCreatedTimeFilterSchema,
                  TimestampLastEditedTimeFilterSchema,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["or"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      and: {
                        type: "array",
                        items: PropertyFilterSchema,
                      },
                    },
                    required: ["and"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["and"],
          additionalProperties: false,
        },
        PropertyFilterSchema,
        TimestampCreatedTimeFilterSchema,
        TimestampLastEditedTimeFilterSchema,
      ],
    },
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
    archived: {
      type: "boolean",
    },
    filter_properties: {
      type: "array",
      items: {
        type: "string",
      },
    },
    database_id: IdRequestSchema,
  },
  required: ["database_id"],
};

export const QueryDatabaseResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "page",
    },
    page: EmptyObjectSchema,
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
        anyOf: [PageObjectResponseSchema, PartialPageObjectResponseSchema],
      },
    },
  },
  required: ["type", "page", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
