import { JSONSchema } from "core/schemas/types";
import { EmojisSchema } from "./emojis";
import {
  PartialUserObjectResponseSchema,
  UserObjectResponseSchema,
} from "./user";
import { StringRequestSchema } from "./primitives";
import {
  TextRequestSchema,
  SelectPropertyResponseSchema,
  DateResponseSchema,
  FormulaPropertyResponseSchema,
  RichTextItemResponseSchema,
  RollupFunctionSchema,
} from "./properties";

export const PartialPageObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    object: {
      type: "string",
      const: "page",
    },
    id: {
      type: "string",
    },
  },
  required: ["object", "id"],
  additionalProperties: false,
};

export const PageProperties: JSONSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "number",
          },
          number: {
            type: ["number", "null"],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "number", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "url",
          },
          url: {
            type: ["string", "null"],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "url", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "select",
          },
          select: {
            anyOf: [
              SelectPropertyResponseSchema,
              {
                type: "null",
              },
            ],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "select", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "multi_select",
          },
          multi_select: {
            type: "array",
            items: SelectPropertyResponseSchema,
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "multi_select", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "status",
          },
          status: {
            anyOf: [
              SelectPropertyResponseSchema,
              {
                type: "null",
              },
            ],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "status", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "date",
          },
          date: {
            anyOf: [
              DateResponseSchema,
              {
                type: "null",
              },
            ],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "date", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "email",
          },
          email: {
            type: ["string", "null"],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "email", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "phone_number",
          },
          phone_number: {
            type: ["string", "null"],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "phone_number", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "checkbox",
          },
          checkbox: {
            type: "boolean",
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "checkbox", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "files",
          },
          files: {
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    file: {
                      type: "object",
                      properties: {
                        url: {
                          type: "string",
                        },
                        expiry_time: {
                          type: "string",
                        },
                      },
                      required: ["url", "expiry_time"],
                      additionalProperties: false,
                    },
                    name: StringRequestSchema,
                    type: {
                      type: "string",
                      const: "file",
                    },
                  },
                  required: ["file", "name"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    external: {
                      type: "object",
                      properties: {
                        url: TextRequestSchema,
                      },
                      required: ["url"],
                      additionalProperties: false,
                    },
                    name: StringRequestSchema,
                    type: {
                      type: "string",
                      const: "external",
                    },
                  },
                  required: ["external", "name"],
                  additionalProperties: false,
                },
              ],
            },
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "files", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "created_by",
          },
          created_by: {
            anyOf: [PartialUserObjectResponseSchema, UserObjectResponseSchema],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "created_by", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "created_time",
          },
          created_time: {
            type: "string",
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "created_time", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "last_edited_by",
          },
          last_edited_by: {
            anyOf: [PartialUserObjectResponseSchema, UserObjectResponseSchema],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "last_edited_by", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "last_edited_time",
          },
          last_edited_time: {
            type: "string",
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "last_edited_time", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "formula",
          },
          formula: FormulaPropertyResponseSchema,
          id: {
            type: "string",
          },
        },
        required: ["type", "formula", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "title",
          },
          title: {
            type: "array",
            items: RichTextItemResponseSchema,
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "title", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "rich_text",
          },
          rich_text: {
            type: "array",
            items: RichTextItemResponseSchema,
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "rich_text", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "people",
          },
          people: {
            type: "array",
            items: {
              anyOf: [
                PartialUserObjectResponseSchema,
                UserObjectResponseSchema,
              ],
            },
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "people", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "relation",
          },
          relation: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "relation", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            const: "rollup",
          },
          rollup: {
            anyOf: [
              {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    const: "number",
                  },
                  number: {
                    type: ["number", "null"],
                  },
                  function: RollupFunctionSchema,
                },
                required: ["type", "number", "function"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    const: "date",
                  },
                  date: {
                    anyOf: [
                      DateResponseSchema,
                      {
                        type: "null",
                      },
                    ],
                  },
                  function: RollupFunctionSchema,
                },
                required: ["type", "date", "function"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    const: "array",
                  },
                  array: {
                    type: "array",
                    items: {
                      anyOf: [
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              const: "title",
                            },
                            title: {
                              type: "array",
                              items: RichTextItemResponseSchema,
                            },
                          },
                          required: ["type", "title"],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              const: "rich_text",
                            },
                            rich_text: {
                              type: "array",
                              items: RichTextItemResponseSchema,
                            },
                          },
                          required: ["type", "rich_text"],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              const: "people",
                            },
                            people: {
                              type: "array",
                              items: {
                                anyOf: [
                                  PartialUserObjectResponseSchema,
                                  UserObjectResponseSchema,
                                ],
                              },
                            },
                          },
                          required: ["type", "people"],
                          additionalProperties: false,
                        },
                        {
                          type: "object",
                          properties: {
                            type: {
                              type: "string",
                              const: "relation",
                            },
                            relation: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  id: {
                                    type: "string",
                                  },
                                },
                                required: ["id"],
                                additionalProperties: false,
                              },
                            },
                          },
                          required: ["type", "relation"],
                          additionalProperties: false,
                        },
                      ],
                    },
                  },
                  function: RollupFunctionSchema,
                },
                required: ["type", "array", "function"],
                additionalProperties: false,
              },
            ],
          },
          id: {
            type: "string",
          },
        },
        required: ["type", "rollup", "id"],
        additionalProperties: false,
      },
    ],
  },
};

export const PageObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    parent: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "database_id",
            },
            database_id: {
              type: "string",
            },
          },
          required: ["type", "database_id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "page_id",
            },
            page_id: {
              type: "string",
            },
          },
          required: ["type", "page_id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "block_id",
            },
            block_id: {
              type: "string",
            },
          },
          required: ["type", "block_id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "workspace",
            },
            workspace: {
              type: "boolean",
              const: true,
            },
          },
          required: ["type", "workspace"],
          additionalProperties: false,
        },
      ],
    },
    properties: PageProperties,
    icon: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "emoji",
            },
            emoji: EmojisSchema,
          },
          required: ["type", "emoji"],
          additionalProperties: false,
        },
        {
          type: "null",
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "external",
            },
            external: {
              type: "object",
              properties: {
                url: TextRequestSchema,
              },
              required: ["url"],
              additionalProperties: false,
            },
          },
          required: ["type", "external"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "file",
            },
            file: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                },
                expiry_time: {
                  type: "string",
                },
              },
              required: ["url", "expiry_time"],
              additionalProperties: false,
            },
          },
          required: ["type", "file"],
          additionalProperties: false,
        },
      ],
    },
    cover: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "external",
            },
            external: {
              type: "object",
              properties: {
                url: TextRequestSchema,
              },
              required: ["url"],
              additionalProperties: false,
            },
          },
          required: ["type", "external"],
          additionalProperties: false,
        },
        {
          type: "null",
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "file",
            },
            file: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                },
                expiry_time: {
                  type: "string",
                },
              },
              required: ["url", "expiry_time"],
              additionalProperties: false,
            },
          },
          required: ["type", "file"],
          additionalProperties: false,
        },
      ],
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_by: PartialUserObjectResponseSchema,
    object: {
      type: "string",
      const: "page",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    last_edited_time: {
      type: "string",
    },
    archived: {
      type: "boolean",
    },
    url: {
      type: "string",
    },
  },
  required: [
    "parent",
    "properties",
    "icon",
    "cover",
    "created_by",
    "last_edited_by",
    "object",
    "id",
    "created_time",
    "last_edited_time",
    "archived",
    "url",
  ],
  additionalProperties: false,
};
