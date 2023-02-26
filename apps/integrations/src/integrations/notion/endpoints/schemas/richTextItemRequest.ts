import { JSONSchema } from "core/schemas/types";
import { EmptyObject, IdRequest } from "./common";
import { DateRequest } from "./dateRequest";
import { PartialUserObjectResponse } from "./person";
import { TextRequest } from "./requests";

export const RichTextItemRequest: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        text: {
          type: "object",
          properties: {
            content: {
              type: "string",
            },
            link: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    url: TextRequest,
                  },
                  required: ["url"],
                  additionalProperties: false,
                },
                {
                  type: "null",
                },
              ],
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "text",
        },
        annotations: {
          type: "object",
          properties: {
            bold: {
              type: "boolean",
            },
            italic: {
              type: "boolean",
            },
            strikethrough: {
              type: "boolean",
            },
            underline: {
              type: "boolean",
            },
            code: {
              type: "boolean",
            },
            color: {
              type: "string",
              enum: [
                "default",
                "gray",
                "brown",
                "orange",
                "yellow",
                "green",
                "blue",
                "purple",
                "pink",
                "red",
                "gray_background",
                "brown_background",
                "orange_background",
                "yellow_background",
                "green_background",
                "blue_background",
                "purple_background",
                "pink_background",
                "red_background",
              ],
            },
          },
          additionalProperties: false,
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mention: {
          anyOf: [
            {
              type: "object",
              properties: {
                user: {
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
              required: ["user"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                date: DateRequest,
              },
              required: ["date"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                page: {
                  type: "object",
                  properties: {
                    id: IdRequest,
                  },
                  required: ["id"],
                  additionalProperties: false,
                },
              },
              required: ["page"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                database: {
                  type: "object",
                  properties: {
                    id: IdRequest,
                  },
                  required: ["id"],
                  additionalProperties: false,
                },
              },
              required: ["database"],
              additionalProperties: false,
            },
          ],
        },
        type: {
          type: "string",
          const: "mention",
        },
        annotations: {
          type: "object",
          properties: {
            bold: {
              type: "boolean",
            },
            italic: {
              type: "boolean",
            },
            strikethrough: {
              type: "boolean",
            },
            underline: {
              type: "boolean",
            },
            code: {
              type: "boolean",
            },
            color: {
              type: "string",
              enum: [
                "default",
                "gray",
                "brown",
                "orange",
                "yellow",
                "green",
                "blue",
                "purple",
                "pink",
                "red",
                "gray_background",
                "brown_background",
                "orange_background",
                "yellow_background",
                "green_background",
                "blue_background",
                "purple_background",
                "pink_background",
                "red_background",
              ],
            },
          },
          additionalProperties: false,
        },
      },
      required: ["mention"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        equation: {
          type: "object",
          properties: {
            expression: TextRequest,
          },
          required: ["expression"],
          additionalProperties: false,
        },
        type: {
          type: "string",
          const: "equation",
        },
        annotations: {
          type: "object",
          properties: {
            bold: {
              type: "boolean",
            },
            italic: {
              type: "boolean",
            },
            strikethrough: {
              type: "boolean",
            },
            underline: {
              type: "boolean",
            },
            code: {
              type: "boolean",
            },
            color: {
              type: "string",
              enum: [
                "default",
                "gray",
                "brown",
                "orange",
                "yellow",
                "green",
                "blue",
                "purple",
                "pink",
                "red",
                "gray_background",
                "brown_background",
                "orange_background",
                "yellow_background",
                "green_background",
                "blue_background",
                "purple_background",
                "pink_background",
                "red_background",
              ],
            },
          },
          additionalProperties: false,
        },
      },
      required: ["equation"],
      additionalProperties: false,
    },
  ],
};
