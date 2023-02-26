import { JSONSchema } from "core/schemas/types";
import {
  StringRequest,
  SelectColor,
  EmptyObject,
  IdRequest,
  NeverRecord,
} from "../common";
import {
  PartialDatabaseObjectResponse,
  DatabaseObjectResponse,
} from "../database";
import { NumberFormat } from "../databasePropertyConfigs";
import { EmojiRequest } from "../emoji";
import { RollupFunction } from "../functions";
import { TextRequest } from "../requests";
import { RichTextItemRequest } from "../richTextItemRequest";

export const CreateDatabaseBodyParametersProperties: JSONSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [
      {
        type: "object",
        properties: {
          number: {
            type: "object",
            properties: {
              format: NumberFormat,
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "number",
          },
        },
        required: ["number"],
        additionalProperties: false,
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
                  type: "object",
                  properties: {
                    name: StringRequest,
                    color: SelectColor,
                  },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "select",
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
                  type: "object",
                  properties: {
                    name: StringRequest,
                    color: SelectColor,
                  },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          type: {
            type: "string",
            const: "multi_select",
          },
        },
        required: ["multi_select"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: EmptyObject,
          type: {
            type: "string",
            const: "status",
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
                  single_property: EmptyObject,
                  database_id: IdRequest,
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
                  dual_property: NeverRecord,
                  database_id: IdRequest,
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
                  function: RollupFunction,
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
                  function: RollupFunction,
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
                  function: RollupFunction,
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
                  function: RollupFunction,
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
        },
        required: ["rollup"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          title: EmptyObject,
          type: {
            type: "string",
            const: "title",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          rich_text: EmptyObject,
          type: {
            type: "string",
            const: "rich_text",
          },
        },
        required: ["rich_text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          url: EmptyObject,
          type: {
            type: "string",
            const: "url",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          people: EmptyObject,
          type: {
            type: "string",
            const: "people",
          },
        },
        required: ["people"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          files: EmptyObject,
          type: {
            type: "string",
            const: "files",
          },
        },
        required: ["files"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          email: EmptyObject,
          type: {
            type: "string",
            const: "email",
          },
        },
        required: ["email"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          phone_number: EmptyObject,
          type: {
            type: "string",
            const: "phone_number",
          },
        },
        required: ["phone_number"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          date: EmptyObject,
          type: {
            type: "string",
            const: "date",
          },
        },
        required: ["date"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          checkbox: EmptyObject,
          type: {
            type: "string",
            const: "checkbox",
          },
        },
        required: ["checkbox"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          created_by: EmptyObject,
          type: {
            type: "string",
            const: "created_by",
          },
        },
        required: ["created_by"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          created_time: EmptyObject,
          type: {
            type: "string",
            const: "created_time",
          },
        },
        required: ["created_time"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          last_edited_by: EmptyObject,
          type: {
            type: "string",
            const: "last_edited_by",
          },
        },
        required: ["last_edited_by"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          last_edited_time: EmptyObject,
          type: {
            type: "string",
            const: "last_edited_time",
          },
        },
        required: ["last_edited_time"],
        additionalProperties: false,
      },
    ],
  },
};

export const CreateDatabaseBodyParameters: JSONSchema = {
  type: "object",
  properties: {
    parent: {
      type: "object",
      properties: {
        page_id: IdRequest,
        type: {
          type: "string",
          const: "page_id",
        },
      },
      required: ["page_id"],
      additionalProperties: false,
    },
    properties: CreateDatabaseBodyParametersProperties,
    icon: {
      anyOf: [
        {
          type: "object",
          properties: {
            emoji: EmojiRequest,
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
                url: TextRequest,
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
                url: TextRequest,
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
    title: {
      type: "array",
      items: RichTextItemRequest,
    },
    description: {
      type: "array",
      items: RichTextItemRequest,
    },
    is_inline: {
      type: "boolean",
    },
  },
  required: ["parent", "properties"],
  additionalProperties: false,
};

export const CreateDatabaseParameters: JSONSchema =
  CreateDatabaseBodyParameters;

export const CreateDatabaseResponse: JSONSchema = {
  anyOf: [PartialDatabaseObjectResponse, DatabaseObjectResponse],
};
