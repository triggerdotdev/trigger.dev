import { JSONSchema } from "core/schemas/types";
import { ApiColorSchema } from "./common";
import { PartialUserObjectResponseSchema } from "./user";
import { EmptyObjectSchema, IdRequestSchema } from "./primitives";
import {
  CodeBlockObjectResponseSchema,
  RichTextItemResponseSchema,
  TextRequestSchema,
} from "./properties";
import { EmojisSchema } from "./emojis";

export const PartialBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
  },
  required: ["object", "id"],
  additionalProperties: false,
};

export const ParagraphBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "paragraph",
    },
    paragraph: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "paragraph",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const Heading1BlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "heading_1",
    },
    heading_1: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "heading_1",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const Heading2BlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "heading_2",
    },
    heading_2: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "heading_2",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const Heading3BlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "heading_3",
    },
    heading_3: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "heading_3",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const BulletedListItemBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "bulleted_list_item",
    },
    bulleted_list_item: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "bulleted_list_item",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const NumberedListItemBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "numbered_list_item",
    },
    numbered_list_item: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "numbered_list_item",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const QuoteBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "quote",
    },
    quote: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "quote",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ToDoBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "to_do",
    },
    to_do: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
        checked: {
          type: "boolean",
        },
      },
      required: ["rich_text", "color", "checked"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "to_do",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ToggleBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "toggle",
    },
    toggle: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
      },
      required: ["rich_text", "color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "toggle",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const TemplateBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "template",
    },
    template: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
      },
      required: ["rich_text"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "template",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const SyncedBlockBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "synced_block",
    },
    synced_block: {
      type: "object",
      properties: {
        synced_from: {
          anyOf: [
            {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  const: "block_id",
                },
                block_id: IdRequestSchema,
              },
              required: ["type", "block_id"],
              additionalProperties: false,
            },
            {
              type: "null",
            },
          ],
        },
      },
      required: ["synced_from"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "synced_block",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ChildPageBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "child_page",
    },
    child_page: {
      type: "object",
      properties: {
        title: {
          type: "string",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "child_page",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ChildDatabaseBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "child_database",
    },
    child_database: {
      type: "object",
      properties: {
        title: {
          type: "string",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "child_database",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const EquationBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "equation",
    },
    equation: {
      type: "object",
      properties: {
        expression: {
          type: "string",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "equation",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const CalloutBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "callout",
    },
    callout: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        color: ApiColorSchema,
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
      },
      required: ["rich_text", "color", "icon"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "callout",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const DividerBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "divider",
    },
    divider: EmptyObjectSchema,
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "divider",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const BreadcrumbBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "breadcrumb",
    },
    breadcrumb: EmptyObjectSchema,
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "breadcrumb",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const TableOfContentsBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "table_of_contents",
    },
    table_of_contents: {
      type: "object",
      properties: {
        color: ApiColorSchema,
      },
      required: ["color"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "table_of_contents",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ColumnListBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "column_list",
    },
    column_list: EmptyObjectSchema,
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "column_list",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ColumnBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "column",
    },
    column: EmptyObjectSchema,
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "column",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const LinkToPageBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "link_to_page",
    },
    link_to_page: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "page_id",
            },
            page_id: IdRequestSchema,
          },
          required: ["type", "page_id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "database_id",
            },
            database_id: IdRequestSchema,
          },
          required: ["type", "database_id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "comment_id",
            },
            comment_id: IdRequestSchema,
          },
          required: ["type", "comment_id"],
          additionalProperties: false,
        },
      ],
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "link_to_page",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const TableBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "table",
    },
    table: {
      type: "object",
      properties: {
        has_column_header: {
          type: "boolean",
        },
        has_row_header: {
          type: "boolean",
        },
        table_width: {
          type: "number",
        },
      },
      required: ["has_column_header", "has_row_header", "table_width"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "table",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const TableRowBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "table_row",
    },
    table_row: {
      type: "object",
      properties: {
        cells: {
          type: "array",
          items: {
            type: "array",
            items: RichTextItemResponseSchema,
          },
        },
      },
      required: ["cells"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "table_row",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const EmbedBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "embed",
    },
    embed: {
      type: "object",
      properties: {
        url: {
          type: "string",
        },
        caption: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
      },
      required: ["url", "caption"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "embed",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const BookmarkBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "bookmark",
    },
    bookmark: {
      type: "object",
      properties: {
        url: {
          type: "string",
        },
        caption: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
      },
      required: ["url", "caption"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "bookmark",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const ImageBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "image",
    },
    image: {
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "external", "caption"],
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "file", "caption"],
          additionalProperties: false,
        },
      ],
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "image",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const VideoBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "video",
    },
    video: {
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "external", "caption"],
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "file", "caption"],
          additionalProperties: false,
        },
      ],
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "video",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const PdfBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "pdf",
    },
    pdf: {
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "external", "caption"],
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "file", "caption"],
          additionalProperties: false,
        },
      ],
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "pdf",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const FileBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "file",
    },
    file: {
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "external", "caption"],
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "file", "caption"],
          additionalProperties: false,
        },
      ],
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "file",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const AudioBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "audio",
    },
    audio: {
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "external", "caption"],
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
            caption: {
              type: "array",
              items: RichTextItemResponseSchema,
            },
          },
          required: ["type", "file", "caption"],
          additionalProperties: false,
        },
      ],
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "audio",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const LinkPreviewBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "link_preview",
    },
    link_preview: {
      type: "object",
      properties: {
        url: TextRequestSchema,
      },
      required: ["url"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "link_preview",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const UnsupportedBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "unsupported",
    },
    unsupported: EmptyObjectSchema,
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "unsupported",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const BlockObjectResponseSchema: JSONSchema = {
  anyOf: [
    ParagraphBlockObjectResponseSchema,
    Heading1BlockObjectResponseSchema,
    Heading2BlockObjectResponseSchema,
    Heading3BlockObjectResponseSchema,
    BulletedListItemBlockObjectResponseSchema,
    NumberedListItemBlockObjectResponseSchema,
    QuoteBlockObjectResponseSchema,
    ToDoBlockObjectResponseSchema,
    ToggleBlockObjectResponseSchema,
    TemplateBlockObjectResponseSchema,
    SyncedBlockBlockObjectResponseSchema,
    ChildPageBlockObjectResponseSchema,
    ChildDatabaseBlockObjectResponseSchema,
    EquationBlockObjectResponseSchema,
    CodeBlockObjectResponseSchema,
    CalloutBlockObjectResponseSchema,
    DividerBlockObjectResponseSchema,
    BreadcrumbBlockObjectResponseSchema,
    TableOfContentsBlockObjectResponseSchema,
    ColumnListBlockObjectResponseSchema,
    ColumnBlockObjectResponseSchema,
    LinkToPageBlockObjectResponseSchema,
    TableBlockObjectResponseSchema,
    TableRowBlockObjectResponseSchema,
    EmbedBlockObjectResponseSchema,
    BookmarkBlockObjectResponseSchema,
    ImageBlockObjectResponseSchema,
    VideoBlockObjectResponseSchema,
    PdfBlockObjectResponseSchema,
    FileBlockObjectResponseSchema,
    AudioBlockObjectResponseSchema,
    LinkPreviewBlockObjectResponseSchema,
    UnsupportedBlockObjectResponseSchema,
  ],
};
