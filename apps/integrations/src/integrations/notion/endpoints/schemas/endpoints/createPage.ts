import { JSONSchema } from "core/schemas/types";
import { BlockObjectRequest } from "../blockRequests";
import { EmptyObject, IdRequest, SelectColor, StringRequest } from "../common";
import { DateRequest } from "../dateRequest";
import { EmojiRequest } from "../emoji";
import { PageObjectResponse, PartialPageObjectResponse } from "../page";
import { PartialUserObjectResponse } from "../person";
import { TextRequest } from "../requests";
import { RichTextItemRequest } from "../richTextItemRequest";

export const CreatePageBodyParametersProperties1: JSONSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [
      {
        type: "object",
        properties: {
          title: {
            type: "array",
            items: RichTextItemRequest,
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
            items: RichTextItemRequest,
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
              TextRequest,
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
                  id: StringRequest,
                  name: StringRequest,
                  color: SelectColor,
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
                  name: StringRequest,
                  id: StringRequest,
                  color: SelectColor,
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
                    id: StringRequest,
                    name: StringRequest,
                    color: SelectColor,
                  },
                  required: ["id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    name: StringRequest,
                    id: StringRequest,
                    color: SelectColor,
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
                    id: IdRequest,
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
                    id: IdRequest,
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
                        EmptyObject,
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
                                            id: IdRequest,
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
                                        PartialUserObjectResponse,
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
                    id: IdRequest,
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
              StringRequest,
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
              StringRequest,
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
              DateRequest,
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
                id: IdRequest,
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
                  id: StringRequest,
                  name: StringRequest,
                  color: SelectColor,
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
                  name: StringRequest,
                  id: StringRequest,
                  color: SelectColor,
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

export const CreatePageBodyParametersProperties2: JSONSchema = {
  type: "object",
  additionalProperties: {
    anyOf: [
      {
        type: "array",
        items: RichTextItemRequest,
      },
      {
        type: "number",
      },
      {
        type: "null",
      },
      TextRequest,
      {
        type: "object",
        properties: {
          id: StringRequest,
          name: StringRequest,
          color: SelectColor,
        },
        required: ["id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          name: StringRequest,
          id: StringRequest,
          color: SelectColor,
        },
        required: ["name"],
        additionalProperties: false,
      },
      {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                id: StringRequest,
                name: StringRequest,
                color: SelectColor,
              },
              required: ["id"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                name: StringRequest,
                id: StringRequest,
                color: SelectColor,
              },
              required: ["name"],
              additionalProperties: false,
            },
          ],
        },
      },
      {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                id: IdRequest,
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
                id: IdRequest,
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
                    EmptyObject,
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
                                        id: IdRequest,
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
                                    PartialUserObjectResponse,
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
                id: IdRequest,
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
      StringRequest,
      DateRequest,
      {
        type: "boolean",
      },
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: IdRequest,
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
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
      {
        type: "object",
        properties: {
          id: StringRequest,
          name: StringRequest,
          color: SelectColor,
        },
        required: ["id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          name: StringRequest,
          id: StringRequest,
          color: SelectColor,
        },
        required: ["name"],
        additionalProperties: false,
      },
    ],
  },
};

export const CreatePageBodyParameters: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        parent: {
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
        properties: {
          anyOf: [
            CreatePageBodyParametersProperties1,
            CreatePageBodyParametersProperties2,
          ],
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
        content: {
          type: "array",
          items: BlockObjectRequest,
        },
        children: {
          type: "array",
          items: BlockObjectRequest,
        },
      },
      required: ["parent", "properties"],
      additionalProperties: false,
    },
    {
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
        properties: {
          type: "object",
          properties: {
            title: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    title: {
                      type: "array",
                      items: RichTextItemRequest,
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
                  type: "array",
                  items: RichTextItemRequest,
                },
              ],
            },
          },
          additionalProperties: false,
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
        children: {
          type: "array",
          items: BlockObjectRequest,
        },
      },
      required: ["parent", "properties"],
      additionalProperties: false,
    },
  ],
};

export const CreatePageParameters: JSONSchema = CreatePageBodyParameters;

export const CreatePageResponse: JSONSchema = {
  anyOf: [PageObjectResponse, PartialPageObjectResponse],
};
