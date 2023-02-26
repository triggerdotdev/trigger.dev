import { JSONSchema } from "core/schemas/types";

export const CreateCommentBodyParameters: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "parent": {
          "type": "object",
          "properties": {
            "page_id": IdRequest,
            "type": {
              "type": "string",
              "const": "page_id"
            }
          },
          "required": [
            "page_id"
          ],
          "additionalProperties": false
        },
        "rich_text": {
          "type": "array",
          "items": RichTextItemRequest
        }
      },
      "required": [
        "parent",
        "rich_text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "discussion_id": IdRequest,
        "rich_text": {
          "type": "array",
          "items": RichTextItemRequest
        }
      },
      "required": [
        "discussion_id",
        "rich_text"
      ],
      "additionalProperties": false
    }
  ]
};

export const CreateCommentParameters: JSONSchema = CreateCommentBodyParameters;

export const CreateCommentResponse: JSONSchema = {
  "anyOf": [
    CommentObjectResponse,
    PartialCommentObjectResponse
  ]
};