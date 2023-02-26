import { JSONSchema } from "core/schemas/types";
import { EmptyObject, IdRequest } from "../common";
import {
  PropertyFilter,
  TimestampCreatedTimeFilter,
  TimestampLastEditedTimeFilter,
} from "../filters";
import { PageObjectResponse, PartialPageObjectResponse } from "../page";

export const QueryDatabasePathParameters: JSONSchema = {
  type: "object",
  properties: {
    database_id: IdRequest,
  },
  required: ["database_id"],
  additionalProperties: false,
};

export const QueryDatabaseQueryParameters: JSONSchema = {
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

export const QueryDatabaseBodyParameters: JSONSchema = {
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
                  PropertyFilter,
                  TimestampCreatedTimeFilter,
                  TimestampLastEditedTimeFilter,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilter,
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
                        items: PropertyFilter,
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
                  PropertyFilter,
                  TimestampCreatedTimeFilter,
                  TimestampLastEditedTimeFilter,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilter,
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
                        items: PropertyFilter,
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
        PropertyFilter,
        TimestampCreatedTimeFilter,
        TimestampLastEditedTimeFilter,
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

export const QueryDatabaseParameters: JSONSchema = {
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
                  PropertyFilter,
                  TimestampCreatedTimeFilter,
                  TimestampLastEditedTimeFilter,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilter,
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
                        items: PropertyFilter,
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
                  PropertyFilter,
                  TimestampCreatedTimeFilter,
                  TimestampLastEditedTimeFilter,
                  {
                    type: "object",
                    properties: {
                      or: {
                        type: "array",
                        items: PropertyFilter,
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
                        items: PropertyFilter,
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
        PropertyFilter,
        TimestampCreatedTimeFilter,
        TimestampLastEditedTimeFilter,
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
    database_id: IdRequest,
  },
  required: ["database_id"],
};

export const QueryDatabaseResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "page",
    },
    page: EmptyObject,
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
        anyOf: [PageObjectResponse, PartialPageObjectResponse],
      },
    },
  },
  required: ["type", "page", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
