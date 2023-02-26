import { JSONSchema } from "core/schemas/types";
import { StringRequest } from "./common";
import { EmojiRequest } from "./emoji";
import { RollupFunction } from "./functions";
import { PartialUserObjectResponse, UserObjectResponse } from "./person";
import { TextRequest } from "./requests";
import {
  DateResponse,
  FormulaPropertyResponse,
  RichTextItemResponse,
  SelectPropertyResponse,
} from "./responses";

export const PageObjectResponseProperties: JSONSchema = {
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
              SelectPropertyResponse,
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
            items: SelectPropertyResponse,
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
              SelectPropertyResponse,
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
              DateResponse,
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
                    name: StringRequest,
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
                        url: TextRequest,
                      },
                      required: ["url"],
                      additionalProperties: false,
                    },
                    name: StringRequest,
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
            anyOf: [PartialUserObjectResponse, UserObjectResponse],
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
            anyOf: [PartialUserObjectResponse, UserObjectResponse],
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
          formula: FormulaPropertyResponse,
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
            items: RichTextItemResponse,
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
            items: RichTextItemResponse,
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
              anyOf: [PartialUserObjectResponse, UserObjectResponse],
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
                  function: RollupFunction,
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
                      DateResponse,
                      {
                        type: "null",
                      },
                    ],
                  },
                  function: RollupFunction,
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
                              items: RichTextItemResponse,
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
                              items: RichTextItemResponse,
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
                                  PartialUserObjectResponse,
                                  UserObjectResponse,
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
                  function: RollupFunction,
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

export const PageObjectResponse: JSONSchema = {
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
    properties: PageObjectResponseProperties,
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
    created_by: PartialUserObjectResponse,
    last_edited_by: PartialUserObjectResponse,
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

export const PartialPageObjectResponse: JSONSchema = {
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
