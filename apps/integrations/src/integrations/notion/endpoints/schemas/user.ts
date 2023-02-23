import { JSONSchema } from "core/schemas/types";
import {
  EmptyObjectSchema,
  IdRequestSchema,
  NeverRecordSchema,
} from "./primitives";

export const PersonUserObjectResponseSchema: JSONSchema = {
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
  required: ["type", "person", "name", "avatar_url", "id", "object"],
  additionalProperties: false,
};

export const PartialUserObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    id: IdRequestSchema,
    object: {
      type: "string",
      const: "user",
    },
  },
  required: ["id", "object"],
  additionalProperties: false,
};

export const BotUserObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "bot",
    },
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
  required: ["type", "bot", "name", "avatar_url", "id", "object"],
  additionalProperties: false,
};

export const UserObjectResponseSchema: JSONSchema = {
  anyOf: [PersonUserObjectResponseSchema, BotUserObjectResponseSchema],
};

export const GetSelfParametersSchema: JSONSchema = NeverRecordSchema;

export const GetSelfResponseSchema: JSONSchema = UserObjectResponseSchema;

export const GetUserPathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    user_id: IdRequestSchema,
  },
  required: ["user_id"],
  additionalProperties: false,
};

export const GetUserParametersSchema: JSONSchema = GetUserPathParametersSchema;

export const GetUserResponseSchema: JSONSchema = UserObjectResponseSchema;

export const ListUsersQueryParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    start_cursor: {
      type: "string",
    },
    page_size: {
      type: "number",
    },
  },
  additionalProperties: false,
};

export const ListUsersParametersSchema: JSONSchema =
  ListUsersQueryParametersSchema;

export const ListUsersResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "user",
    },
    user: EmptyObjectSchema,
    object: {
      type: "string",
      const: "list",
    },
    next_cursor: {
      type: ["string", "null"],
    },
    has_more: {
      type: "boolean",
    },
    results: {
      type: "array",
      items: UserObjectResponseSchema,
    },
  },
  required: ["type", "user", "object", "next_cursor", "has_more", "results"],
  additionalProperties: false,
};
