import { JSONSchema } from "core/schemas/types";
import { DatabasePropertyConfigResponse } from "./databasePropertyConfigs";
import { EmojiRequest } from "./emoji";
import { PartialUserObjectResponse } from "./person";
import { TextRequest } from "./requests";
import { RichTextItemResponse } from "./responses";

export const DatabasePropertyConfigResponseRecord: JSONSchema = {
  type: "object",
  additionalProperties: DatabasePropertyConfigResponse,
};

export const PartialDatabaseObjectResponse: JSONSchema = {
  type: "object",
  properties: {
    object: {
      type: "string",
      const: "database",
    },
    id: {
      type: "string",
    },
    properties: DatabasePropertyConfigResponseRecord,
  },
  required: ["object", "id", "properties"],
  additionalProperties: false,
};

export const DatabaseObjectResponse: JSONSchema = {
  type: "object",
  properties: {
    title: {
      type: "array",
      items: RichTextItemResponse,
    },
    description: {
      type: "array",
      items: RichTextItemResponse,
    },
    icon: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "emoji",
            },
            emoji: EmojiRequest,
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
                url: TextRequest,
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
                url: TextRequest,
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
    properties: DatabasePropertyConfigResponseRecord,
    parent: {
      anyOf: [
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
      ],
    },
    created_by: PartialUserObjectResponse,
    last_edited_by: PartialUserObjectResponse,
    is_inline: {
      type: "boolean",
    },
    object: {
      type: "string",
      const: "database",
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
    "title",
    "description",
    "icon",
    "cover",
    "properties",
    "parent",
    "created_by",
    "last_edited_by",
    "is_inline",
    "object",
    "id",
    "created_time",
    "last_edited_time",
    "archived",
    "url",
  ],
  additionalProperties: false,
};
