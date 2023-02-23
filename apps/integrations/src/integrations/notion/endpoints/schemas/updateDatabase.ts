import { JSONSchema } from "core/schemas/types";
import { SelectColorSchema } from "./common";
import {
  PartialDatabaseObjectResponseSchema,
  DatabaseObjectResponseSchema,
} from "./database";
import { EmojisSchema } from "./emojis";
import {
  IdRequestSchema,
  StringRequestSchema,
  EmptyObjectSchema,
  NeverRecordSchema,
} from "./primitives";
import {
  RichTextItemRequestSchema,
  TextRequestSchema,
  NumberFormatSchema,
  RollupFunctionSchema,
} from "./properties";

export const UpdateDatabasePropertiesSchema: JSONSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [
      {
        type: "object",
        properties: {
          number: {
            type: "object",
            properties: {
              format: NumberFormatSchema,
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "number",
          },
          name: {
            type: "string",
          },
        },
        required: ["number"],
        additionalProperties: false,
      },
      {
        type: "null",
      },
      {
        type: "object",
        properties: {
          formula: {
            type: "object",
            properties: {
              expression: {
                type: "string",
              },
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "formula",
          },
          name: {
            type: "string",
          },
        },
        required: ["formula"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          select: {
            type: "object",
            properties: {
              options: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        id: StringRequestSchema,
                        name: StringRequestSchema,
                        color: SelectColorSchema,
                      },
                      required: ["id"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        name: StringRequestSchema,
                        id: StringRequestSchema,
                        color: SelectColorSchema,
                      },
                      required: ["name"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "select",
          },
          name: {
            type: "string",
          },
        },
        required: ["select"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          multi_select: {
            type: "object",
            properties: {
              options: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        id: StringRequestSchema,
                        name: StringRequestSchema,
                        color: SelectColorSchema,
                      },
                      required: ["id"],
                      additionalProperties: false,
                    },
                    {
                      type: "object",
                      properties: {
                        name: StringRequestSchema,
                        id: StringRequestSchema,
                        color: SelectColorSchema,
                      },
                      required: ["name"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "multi_select",
          },
          name: {
            type: "string",
          },
        },
        required: ["multi_select"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: EmptyObjectSchema,
          type: {
            type: "string",
            const: "status",
          },
          name: {
            type: "string",
          },
        },
        required: ["status"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          relation: {
            anyOf: [
              {
                type: "object",
                properties: {
                  single_property: EmptyObjectSchema,
                  database_id: IdRequestSchema,
                  type: {
                    type: "string",
                    const: "single_property",
                  },
                },
                required: ["single_property", "database_id"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  dual_property: NeverRecordSchema,
                  database_id: IdRequestSchema,
                  type: {
                    type: "string",
                    const: "dual_property",
                  },
                },
                required: ["dual_property", "database_id"],
                additionalProperties: false,
              },
            ],
          },
          type: {
            type: "string",
            const: "relation",
          },
          name: {
            type: "string",
          },
        },
        required: ["relation"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          rollup: {
            anyOf: [
              {
                type: "object",
                properties: {
                  rollup_property_name: {
                    type: "string",
                  },
                  relation_property_name: {
                    type: "string",
                  },
                  function: RollupFunctionSchema,
                  rollup_property_id: {
                    type: "string",
                  },
                  relation_property_id: {
                    type: "string",
                  },
                },
                required: [
                  "rollup_property_name",
                  "relation_property_name",
                  "function",
                ],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  rollup_property_name: {
                    type: "string",
                  },
                  relation_property_id: {
                    type: "string",
                  },
                  function: RollupFunctionSchema,
                  relation_property_name: {
                    type: "string",
                  },
                  rollup_property_id: {
                    type: "string",
                  },
                },
                required: [
                  "rollup_property_name",
                  "relation_property_id",
                  "function",
                ],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  relation_property_name: {
                    type: "string",
                  },
                  rollup_property_id: {
                    type: "string",
                  },
                  function: RollupFunctionSchema,
                  rollup_property_name: {
                    type: "string",
                  },
                  relation_property_id: {
                    type: "string",
                  },
                },
                required: [
                  "relation_property_name",
                  "rollup_property_id",
                  "function",
                ],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  rollup_property_id: {
                    type: "string",
                  },
                  relation_property_id: {
                    type: "string",
                  },
                  function: RollupFunctionSchema,
                  rollup_property_name: {
                    type: "string",
                  },
                  relation_property_name: {
                    type: "string",
                  },
                },
                required: [
                  "rollup_property_id",
                  "relation_property_id",
                  "function",
                ],
                additionalProperties: false,
              },
            ],
          },
          type: {
            type: "string",
            const: "rollup",
          },
          name: {
            type: "string",
          },
        },
        required: ["rollup"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          title: EmptyObjectSchema,
          type: {
            type: "string",
            const: "title",
          },
          name: {
            type: "string",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          rich_text: EmptyObjectSchema,
          type: {
            type: "string",
            const: "rich_text",
          },
          name: {
            type: "string",
          },
        },
        required: ["rich_text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          url: EmptyObjectSchema,
          type: {
            type: "string",
            const: "url",
          },
          name: {
            type: "string",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          people: EmptyObjectSchema,
          type: {
            type: "string",
            const: "people",
          },
          name: {
            type: "string",
          },
        },
        required: ["people"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          files: EmptyObjectSchema,
          type: {
            type: "string",
            const: "files",
          },
          name: {
            type: "string",
          },
        },
        required: ["files"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          email: EmptyObjectSchema,
          type: {
            type: "string",
            const: "email",
          },
          name: {
            type: "string",
          },
        },
        required: ["email"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          phone_number: EmptyObjectSchema,
          type: {
            type: "string",
            const: "phone_number",
          },
          name: {
            type: "string",
          },
        },
        required: ["phone_number"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          date: EmptyObjectSchema,
          type: {
            type: "string",
            const: "date",
          },
          name: {
            type: "string",
          },
        },
        required: ["date"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          checkbox: EmptyObjectSchema,
          type: {
            type: "string",
            const: "checkbox",
          },
          name: {
            type: "string",
          },
        },
        required: ["checkbox"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          created_by: EmptyObjectSchema,
          type: {
            type: "string",
            const: "created_by",
          },
          name: {
            type: "string",
          },
        },
        required: ["created_by"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          created_time: EmptyObjectSchema,
          type: {
            type: "string",
            const: "created_time",
          },
          name: {
            type: "string",
          },
        },
        required: ["created_time"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          last_edited_by: EmptyObjectSchema,
          type: {
            type: "string",
            const: "last_edited_by",
          },
          name: {
            type: "string",
          },
        },
        required: ["last_edited_by"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          last_edited_time: EmptyObjectSchema,
          type: {
            type: "string",
            const: "last_edited_time",
          },
          name: {
            type: "string",
          },
        },
        required: ["last_edited_time"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    ],
  },
};

export const UpdateDatabasePathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    database_id: IdRequestSchema,
  },
  required: ["database_id"],
  additionalProperties: false,
};

export const UpdateDatabaseBodyParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    title: {
      type: "array",
      items: RichTextItemRequestSchema,
    },
    description: {
      type: "array",
      items: RichTextItemRequestSchema,
    },
    icon: {
      anyOf: [
        {
          type: "object",
          properties: {
            emoji: EmojisSchema,
            type: {
              type: "string",
              const: "emoji",
            },
          },
          required: ["emoji"],
          additionalProperties: false,
        },
        {
          type: "null",
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
            type: {
              type: "string",
              const: "external",
            },
          },
          required: ["external"],
          additionalProperties: false,
        },
      ],
    },
    cover: {
      anyOf: [
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
            type: {
              type: "string",
              const: "external",
            },
          },
          required: ["external"],
          additionalProperties: false,
        },
        {
          type: "null",
        },
      ],
    },
    properties: UpdateDatabasePropertiesSchema,
    is_inline: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  additionalProperties: false,
};

export const UpdateDatabaseParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "array",
      items: RichTextItemRequestSchema,
    },
    description: {
      type: "array",
      items: RichTextItemRequestSchema,
    },
    icon: {
      anyOf: [
        {
          type: "object",
          properties: {
            emoji: EmojisSchema,
            type: {
              type: "string",
              const: "emoji",
            },
          },
          required: ["emoji"],
          additionalProperties: false,
        },
        {
          type: "null",
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
            type: {
              type: "string",
              const: "external",
            },
          },
          required: ["external"],
          additionalProperties: false,
        },
      ],
    },
    cover: {
      anyOf: [
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
            type: {
              type: "string",
              const: "external",
            },
          },
          required: ["external"],
          additionalProperties: false,
        },
        {
          type: "null",
        },
      ],
    },
    properties: UpdateDatabasePropertiesSchema,
    is_inline: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
    database_id: IdRequestSchema,
  },
  required: ["database_id"],
};

export const UpdateDatabaseResponseSchema: JSONSchema = {
  anyOf: [PartialDatabaseObjectResponseSchema, DatabaseObjectResponseSchema],
};
