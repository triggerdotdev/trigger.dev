import { JSONSchema } from "core/schemas/types";
import { IdRequestSchema } from "./primitives";
import {
  RichTextItemRequestSchema,
  CommentObjectResponseSchema,
  PartialCommentObjectResponseSchema,
} from "./properties";

export const CreateCommentBodyParametersSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        parent: {
          type: "object",
          properties: {
            page_id: IdRequestSchema,
            type: {
              type: "string",
              const: "page_id",
            },
          },
          required: ["page_id"],
          additionalProperties: false,
        },
        rich_text: {
          type: "array",
          items: RichTextItemRequestSchema,
        },
      },
      required: ["parent", "rich_text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        discussion_id: IdRequestSchema,
        rich_text: {
          type: "array",
          items: RichTextItemRequestSchema,
        },
      },
      required: ["discussion_id", "rich_text"],
      additionalProperties: false,
    },
  ],
};

export const CreateCommentParametersSchema: JSONSchema =
  CreateCommentBodyParametersSchema;

export const CreateCommentResponseSchema: JSONSchema = {
  anyOf: [CommentObjectResponseSchema, PartialCommentObjectResponseSchema],
};
