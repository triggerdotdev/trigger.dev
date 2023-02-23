import { JSONSchema } from "core/schemas/types";
import { SelectColorSchema } from "./common";
import { EmojisSchema } from "./emojis";
import {
  PageObjectResponseSchema,
  PartialPageObjectResponseSchema,
} from "./page";
import {
  IdRequestSchema,
  StringRequestSchema,
  EmptyObjectSchema,
} from "./primitives";
import {
  TextRequestSchema,
  RichTextItemRequestSchema,
  DateRequestSchema,
} from "./properties";
import { PartialUserObjectResponseSchema } from "./user";

export const UpdatePageBodyPropertiesSchema: JSONSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [
      {
        type: "object",
        properties: {
          title: {
            type: "array",
            items: RichTextItemRequestSchema,
          },
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
          rich_text: {
            type: "array",
            items: RichTextItemRequestSchema,
          },
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
          number: {
            type: ["number", "null"],
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
          url: {
            anyOf: [
              TextRequestSchema,
              {
                type: "null",
              },
            ],
          },
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
          select: {
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
                type: "null",
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
          people: {
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    id: IdRequestSchema,
                  },
                  required: ["id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    person: {
                      type: "object",
                      properties: {
                        email: {
                          type: "string",
                        },
                      },
                      additionalProperties: false,
                    },
                    id: IdRequestSchema,
                    type: {
                      type: "string",
                      const: "person",
                    },
                    name: {
                      type: ["string", "null"],
                    },
                    avatar_url: {
                      type: ["string", "null"],
                    },
                    object: {
                      type: "string",
                      const: "user",
                    },
                  },
                  required: ["person", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    bot: {
                      anyOf: [
                        EmptyObjectSchema,
                        {
                          type: "object",
                          properties: {
                            owner: {
                              anyOf: [
                                {
                                  type: "object",
                                  properties: {
                                    type: {
                                      type: "string",
                                      const: "user",
                                    },
                                    user: {
                                      anyOf: [
                                        {
                                          type: "object",
                                          properties: {
                                            type: {
                                              type: "string",
                                              const: "person",
                                            },
                                            person: {
                                              type: "object",
                                              properties: {
                                                email: {
                                                  type: "string",
                                                },
                                              },
                                              required: ["email"],
                                              additionalProperties: false,
                                            },
                                            name: {
                                              type: ["string", "null"],
                                            },
                                            avatar_url: {
                                              type: ["string", "null"],
                                            },
                                            id: IdRequestSchema,
                                            object: {
                                              type: "string",
                                              const: "user",
                                            },
                                          },
                                          required: [
                                            "type",
                                            "person",
                                            "name",
                                            "avatar_url",
                                            "id",
                                            "object",
                                          ],
                                          additionalProperties: false,
                                        },
                                        PartialUserObjectResponseSchema,
                                      ],
                                    },
                                  },
                                  required: ["type", "user"],
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
                            workspace_name: {
                              type: ["string", "null"],
                            },
                          },
                          required: ["owner", "workspace_name"],
                          additionalProperties: false,
                        },
                      ],
                    },
                    id: IdRequestSchema,
                    type: {
                      type: "string",
                      const: "bot",
                    },
                    name: {
                      type: ["string", "null"],
                    },
                    avatar_url: {
                      type: ["string", "null"],
                    },
                    object: {
                      type: "string",
                      const: "user",
                    },
                  },
                  required: ["bot", "id"],
                  additionalProperties: false,
                },
              ],
            },
          },
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
          email: {
            anyOf: [
              StringRequestSchema,
              {
                type: "null",
              },
            ],
          },
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
          phone_number: {
            anyOf: [
              StringRequestSchema,
              {
                type: "null",
              },
            ],
          },
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
          date: {
            anyOf: [
              DateRequestSchema,
              {
                type: "null",
              },
            ],
          },
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
          checkbox: {
            type: "boolean",
          },
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
          relation: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: IdRequestSchema,
              },
              required: ["id"],
              additionalProperties: false,
            },
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
                      required: ["url"],
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
          status: {
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
                type: "null",
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
          type: {
            type: "string",
            const: "status",
          },
        },
        required: ["status"],
        additionalProperties: false,
      },
    ],
  },
};

export const UpdatePagePathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    page_id: IdRequestSchema,
  },
  required: ["page_id"],
  additionalProperties: false,
};

export const UpdatePageBodyParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    properties: {
      anyOf: [UpdatePageBodyPropertiesSchema],
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
    archived: {
      type: "boolean",
    },
  },
  additionalProperties: false,
};

export const UpdatePageParametersSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    properties: {
      anyOf: [UpdatePageBodyPropertiesSchema],
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
    archived: {
      type: "boolean",
    },
    page_id: IdRequestSchema,
  },
  required: ["page_id"],
};

export const UpdatePageResponseSchema: JSONSchema = {
  anyOf: [PageObjectResponseSchema, PartialPageObjectResponseSchema],
};
