import { JSONSchema } from "core/schemas/types";
import {
  BlockObjectResponse,
  LanguageRequest,
  PartialBlockObjectResponse,
} from "../blockResponses";
import { ApiColor, EmptyObject, IdRequest } from "../common";
import { EmojiRequest } from "../emoji";
import { TextRequest } from "../requests";
import { RichTextItemRequest } from "../richTextItemRequest";

export const UpdateBlockPathParameters: JSONSchema = {
  type: "object",
  properties: {
    block_id: IdRequest,
  },
  required: ["block_id"],
  additionalProperties: false,
};

export const UpdateBlockBodyParameters: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        embed: {
          type: "object",
          properties: {
            url: {
              type: "string",
            },
            caption: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "embed",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["embed"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        bookmark: {
          type: "object",
          properties: {
            url: {
              type: "string",
            },
            caption: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "bookmark",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["bookmark"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        image: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "image",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["image"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        video: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "video",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["video"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        pdf: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "pdf",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["pdf"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        file: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "file",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        audio: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "audio",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["audio"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        code: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            language: LanguageRequest,
            caption: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "code",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
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
        type: {
          type: "string",
          const: "equation",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["equation"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        divider: EmptyObject,
        type: {
          type: "string",
          const: "divider",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["divider"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        breadcrumb: EmptyObject,
        type: {
          type: "string",
          const: "breadcrumb",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["breadcrumb"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        table_of_contents: {
          type: "object",
          properties: {
            color: ApiColor,
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "table_of_contents",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["table_of_contents"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        link_to_page: {
          anyOf: [
            {
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
            {
              type: "object",
              properties: {
                database_id: IdRequest,
                type: {
                  type: "string",
                  const: "database_id",
                },
              },
              required: ["database_id"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                comment_id: IdRequest,
                type: {
                  type: "string",
                  const: "comment_id",
                },
              },
              required: ["comment_id"],
              additionalProperties: false,
            },
          ],
        },
        type: {
          type: "string",
          const: "link_to_page",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["link_to_page"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        table_row: {
          type: "object",
          properties: {
            cells: {
              type: "array",
              items: {
                type: "array",
                items: RichTextItemRequest,
              },
            },
          },
          required: ["cells"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "table_row",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["table_row"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        heading_1: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
            is_toggleable: {
              type: "boolean",
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "heading_1",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["heading_1"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        heading_2: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
            is_toggleable: {
              type: "boolean",
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "heading_2",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["heading_2"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        heading_3: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
            is_toggleable: {
              type: "boolean",
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "heading_3",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["heading_3"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        paragraph: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "paragraph",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["paragraph"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        bulleted_list_item: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "bulleted_list_item",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["bulleted_list_item"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        numbered_list_item: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "numbered_list_item",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["numbered_list_item"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        quote: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "quote",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["quote"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        to_do: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            checked: {
              type: "boolean",
            },
            color: ApiColor,
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "to_do",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["to_do"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        toggle: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "toggle",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["toggle"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        template: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "template",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["template"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        callout: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
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
            color: ApiColor,
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "callout",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["callout"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        synced_block: {
          type: "object",
          properties: {
            synced_from: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    block_id: IdRequest,
                    type: {
                      type: "string",
                      const: "block_id",
                    },
                  },
                  required: ["block_id"],
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
        type: {
          type: "string",
          const: "synced_block",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["synced_block"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        table: {
          type: "object",
          properties: {
            has_column_header: {
              type: "boolean",
            },
            has_row_header: {
              type: "boolean",
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "table",
        },
        archived: {
          type: "boolean",
        },
      },
      required: ["table"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        archived: {
          type: "boolean",
        },
      },
      additionalProperties: false,
    },
  ],
};

export const UpdateBlockParameters: JSONSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        embed: {
          type: "object",
          properties: {
            url: {
              type: "string",
            },
            caption: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "embed",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "embed"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        bookmark: {
          type: "object",
          properties: {
            url: {
              type: "string",
            },
            caption: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "bookmark",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "bookmark"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        image: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "image",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "image"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        video: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "video",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "video"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        pdf: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "pdf",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "pdf"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        file: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "file",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "file"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        audio: {
          type: "object",
          properties: {
            caption: {
              type: "array",
              items: RichTextItemRequest,
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
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "audio",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["audio", "block_id"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        code: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            language: LanguageRequest,
            caption: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "code",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "code"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
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
        type: {
          type: "string",
          const: "equation",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "equation"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        divider: EmptyObject,
        type: {
          type: "string",
          const: "divider",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "divider"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        breadcrumb: EmptyObject,
        type: {
          type: "string",
          const: "breadcrumb",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "breadcrumb"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        table_of_contents: {
          type: "object",
          properties: {
            color: ApiColor,
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "table_of_contents",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "table_of_contents"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        link_to_page: {
          anyOf: [
            {
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
            {
              type: "object",
              properties: {
                database_id: IdRequest,
                type: {
                  type: "string",
                  const: "database_id",
                },
              },
              required: ["database_id"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                comment_id: IdRequest,
                type: {
                  type: "string",
                  const: "comment_id",
                },
              },
              required: ["comment_id"],
              additionalProperties: false,
            },
          ],
        },
        type: {
          type: "string",
          const: "link_to_page",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "link_to_page"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        table_row: {
          type: "object",
          properties: {
            cells: {
              type: "array",
              items: {
                type: "array",
                items: RichTextItemRequest,
              },
            },
          },
          required: ["cells"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "table_row",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "table_row"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        heading_1: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
            is_toggleable: {
              type: "boolean",
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "heading_1",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "heading_1"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        heading_2: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
            is_toggleable: {
              type: "boolean",
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "heading_2",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "heading_2"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        heading_3: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
            is_toggleable: {
              type: "boolean",
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "heading_3",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "heading_3"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        paragraph: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "paragraph",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "paragraph"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        bulleted_list_item: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "bulleted_list_item",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "bulleted_list_item"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        numbered_list_item: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "numbered_list_item",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "numbered_list_item"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        quote: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "quote",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "quote"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        to_do: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            checked: {
              type: "boolean",
            },
            color: ApiColor,
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "to_do",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "to_do"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        toggle: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
            color: ApiColor,
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "toggle",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "toggle"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        template: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
          },
          required: ["rich_text"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "template",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "template"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        callout: {
          type: "object",
          properties: {
            rich_text: {
              type: "array",
              items: RichTextItemRequest,
            },
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
            color: ApiColor,
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "callout",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "callout"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        synced_block: {
          type: "object",
          properties: {
            synced_from: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    block_id: IdRequest,
                    type: {
                      type: "string",
                      const: "block_id",
                    },
                  },
                  required: ["block_id"],
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
        type: {
          type: "string",
          const: "synced_block",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "synced_block"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        table: {
          type: "object",
          properties: {
            has_column_header: {
              type: "boolean",
            },
            has_row_header: {
              type: "boolean",
            },
          },
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "table",
        },
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id", "table"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        archived: {
          type: "boolean",
        },
        block_id: IdRequest,
      },
      required: ["block_id"],
    },
  ],
};

export const UpdateBlockResponse: JSONSchema = {
  anyOf: [PartialBlockObjectResponse, BlockObjectResponse],
};
