import { JSONSchema } from "core/schemas/types";
import { TimeZoneSchema } from "./timezone";
import { EmojisSchema } from "./emojis";
import {
  makeArraySchema,
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";

export const PageParentSchema = makeOneOf("Page parent", [
  makeObjectSchema("Database", {
    requiredProperties: {
      type: makeStringSchema("Type", "The type of the parent", {
        const: "database_id",
      }),
      database_id: makeStringSchema(
        "Database ID",
        "Unique identifier for this database"
      ),
    },
  }),
  makeObjectSchema("Page", {
    requiredProperties: {
      type: makeStringSchema("Type", "The type of the parent", {
        const: "page_id",
      }),
      page_id: makeStringSchema("Page ID", "Unique identifier for this page"),
    },
  }),
  makeObjectSchema("Block", {
    requiredProperties: {
      type: makeStringSchema("Type", "The type of the parent", {
        const: "block_id",
      }),
      block_id: makeStringSchema(
        "Block ID",
        "Unique identifier for this block"
      ),
    },
  }),
  makeObjectSchema("Workspace", {
    requiredProperties: {
      type: makeStringSchema("Type", "The type of the parent", {
        const: "workspace",
      }),
      workspace: makeBooleanSchema("Workspace", "Is this a workspace?"),
    },
  }),
]);

const IDSchema = makeStringSchema("ID", "Unique identifier for this property");

function makePropertyTypeSchema(constant: string): JSONSchema {
  return makeStringSchema("Type", "The type of the property", {
    const: constant,
  });
}

// | { type: "number"; number: number | null; id: string }
const NumberSchema = makeObjectSchema("Page property number", {
  requiredProperties: {
    type: makePropertyTypeSchema("number"),
    id: IDSchema,
    number: makeNullable(makeNumberSchema("Number", "The number value")),
  },
});

// | { type: "url"; url: string | null; id: string }
const UrlSchema = makeObjectSchema("Page property URL", {
  requiredProperties: {
    type: makePropertyTypeSchema("url"),
    id: IDSchema,
    url: makeNullable(makeStringSchema("URL", "The URL value")),
  },
});

const SelectColorSchema = makeStringSchema(
  "Select color option",
  "The color a Select can be",
  {
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
    ],
  }
);

const SelectPropertyResponseSchema = makeObjectSchema(
  "Select property response",
  {
    requiredProperties: {
      id: IDSchema,
      name: makeStringSchema("Name", "The name of the select"),
      color: SelectColorSchema,
    },
  }
);

// | { type: "select"; select: SelectPropertyResponse | null; id: string }
const SelectSchema = makeObjectSchema("Page property select", {
  requiredProperties: {
    type: makePropertyTypeSchema("select"),
    id: IDSchema,
    select: makeNullable(SelectPropertyResponseSchema),
  },
});

// | {
//     type: "multi_select"
//     multi_select: Array<SelectPropertyResponse>
//     id: string
//   }
const MultiSelectSchema = makeObjectSchema("Page property multi select", {
  requiredProperties: {
    type: makePropertyTypeSchema("multi_select"),
    id: IDSchema,
    multi_select: makeArraySchema(
      "Multi select options",
      SelectPropertyResponseSchema
    ),
  },
});

// | { type: "status"; status: SelectPropertyResponse | null; id: string }
const StatusSchema = makeObjectSchema("Page property status", {
  requiredProperties: {
    type: makePropertyTypeSchema("status"),
    id: IDSchema,
    status: makeNullable(SelectPropertyResponseSchema),
  },
});

const DateResponseSchema = makeObjectSchema("Date response", {
  requiredProperties: {
    start: makeStringSchema("Start", "The start date"),
    end: makeNullable(makeStringSchema("End", "The end date")),
    time_zone: makeNullable(TimeZoneSchema),
  },
});

// | { type: "date"; date: DateResponse | null; id: string }
const DateSchema = makeObjectSchema("Page property date", {
  requiredProperties: {
    type: makePropertyTypeSchema("date"),
    id: IDSchema,
    date: makeNullable(DateResponseSchema),
  },
});

// | { type: "email"; email: string | null; id: string }
const EmailSchema = makeObjectSchema("Page property email", {
  requiredProperties: {
    type: makePropertyTypeSchema("email"),
    id: IDSchema,
    email: makeNullable(makeStringSchema("Email", "The email value")),
  },
});

// | { type: "phone_number"; phone_number: string | null; id: string }
const PhoneNumberSchema = makeObjectSchema("Page property phone number", {
  requiredProperties: {
    type: makePropertyTypeSchema("phone_number"),
    id: IDSchema,
    phone_number: makeNullable(
      makeStringSchema("Phone number", "The phone number value")
    ),
  },
});

// | { type: "checkbox"; checkbox: boolean; id: string }
const CheckboxSchema = makeObjectSchema("Page property checkbox", {
  requiredProperties: {
    type: makePropertyTypeSchema("checkbox"),
    id: IDSchema,
    checkbox: makeBooleanSchema("Checkbox", "The checkbox value"),
  },
});

// | {
//     type: "files"
//     files: Array<
//       | {
//           file: { url: string; expiry_time: string }
//           name: StringRequest
//           type?: "file"
//         }
//       | {
//           external: { url: TextRequest }
//           name: StringRequest
//           type?: "external"
//         }
//     >
//     id: string
//   }
const FilesSchema = makeObjectSchema("Page property files", {
  requiredProperties: {
    type: makePropertyTypeSchema("files"),
    id: IDSchema,
    files: makeArraySchema(
      "Files",
      makeOneOf("File", [
        makeObjectSchema("File", {
          requiredProperties: {
            file: makeObjectSchema("File", {
              requiredProperties: {
                url: makeStringSchema("URL", "The URL of the file"),
                expiry_time: makeStringSchema(
                  "Expiry time",
                  "The time the file will expire"
                ),
              },
            }),
            name: makeStringSchema("Name", "The name of the file"),
          },
          optionalProperties: {
            type: makeStringSchema("Type", "The type of the file", {
              const: "file",
            }),
          },
        }),
        makeObjectSchema("External", {
          requiredProperties: {
            external: makeObjectSchema("External", {
              requiredProperties: {
                url: makeStringSchema("URL", "The URL of the file"),
                name: makeStringSchema("Name", "The name of the file"),
              },
              optionalProperties: {
                type: makeStringSchema("Type", "The type of the file", {
                  const: "external",
                }),
              },
            }),
          },
        }),
      ])
    ),
  },
});

// export type PartialUserObjectResponse = { id: IdRequest; object: "user" }
// export type UserObjectResponse =
//   | PersonUserObjectResponse
//   | BotUserObjectResponse;

//   export type PersonUserObjectResponse = {
//     type: "person"
//     person: { email?: string }
//     name: string | null
//     avatar_url: string | null
//     id: IdRequest
//     object: "user"
//   }

//   export type BotUserObjectResponse = {
//     type: "bot"
//     bot:
//       | EmptyObject
//       | {
//           owner:
//             | {
//                 type: "user"
//                 user:
//                   | {
//                       type: "person"
//                       person: { email: string }
//                       name: string | null
//                       avatar_url: string | null
//                       id: IdRequest
//                       object: "user"
//                     }
//                   | PartialUserObjectResponse
//               }
//             | { type: "workspace"; workspace: true }
//           workspace_name: string | null
//         }
//     name: string | null
//     avatar_url: string | null
//     id: IdRequest
//     object: "user"
//   }

// | {
//     type: "created_by"
//     created_by: PartialUserObjectResponse | UserObjectResponse
//     id: string
//   }
const CreatedBySchema = makeObjectSchema("Page property created by", {
  requiredProperties: {
    type: makePropertyTypeSchema("created_by"),
    id: IDSchema,
    created_by: makeNullable(UserObjectResponseSchema),
  },
});

// | { type: "created_time"; created_time: string; id: string }
// | {
//     type: "last_edited_by"
//     last_edited_by: PartialUserObjectResponse | UserObjectResponse
//     id: string
//   }
// | { type: "last_edited_time"; last_edited_time: string; id: string }
// | { type: "formula"; formula: FormulaPropertyResponse; id: string }
// | { type: "title"; title: Array<RichTextItemResponse>; id: string }
// | { type: "rich_text"; rich_text: Array<RichTextItemResponse>; id: string }
// | {
//     type: "people"
//     people: Array<PartialUserObjectResponse | UserObjectResponse>
//     id: string
//   }
// | { type: "relation"; relation: Array<{ id: string }>; id: string }
// | {
//     type: "rollup"
//     rollup:
//       | { type: "number"; number: number | null; function: RollupFunction }
//       | {
//           type: "date"
//           date: DateResponse | null
//           function: RollupFunction
//         }
//       | {
//           type: "array"
//           array: Array<
//             | { type: "title"; title: Array<RichTextItemResponse> }
//             | { type: "rich_text"; rich_text: Array<RichTextItemResponse> }
//             | {
//                 type: "people"
//                 people: Array<
//                   PartialUserObjectResponse | UserObjectResponse
//                 >
//               }
//             | { type: "relation"; relation: Array<{ id: string }> }
//           >
//           function: RollupFunction
//         }
//     id: string
//   }
export const PagePropertySchema: JSONSchema = makeOneOf("PageProperty", []);

export const PageSchema: JSONSchema = {
  $ref: "#/definitions/PageObjectResponse",
  $schema: "http://json-schema.org/draft-07/schema#",
  definitions: {
    BotUserObjectResponse: {
      additionalProperties: false,
      properties: {
        avatar_url: {
          type: ["string", "null"],
        },
        bot: {
          anyOf: [
            {
              additionalProperties: {
                not: {},
              },
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                owner: {
                  anyOf: [
                    {
                      additionalProperties: false,
                      properties: {
                        type: {
                          const: "user",
                          type: "string",
                        },
                        user: {
                          anyOf: [
                            {
                              additionalProperties: false,
                              properties: {
                                avatar_url: {
                                  type: ["string", "null"],
                                },
                                id: {
                                  type: ["string"],
                                },
                                name: {
                                  type: ["string", "null"],
                                },
                                object: {
                                  const: "user",
                                  type: "string",
                                },
                                person: {
                                  additionalProperties: false,
                                  properties: {
                                    email: {
                                      type: "string",
                                    },
                                  },
                                  required: ["email"],
                                  type: "object",
                                },
                                type: {
                                  const: "person",
                                  type: "string",
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
                              type: "object",
                            },
                            {
                              $ref: "#/definitions/PartialUserObjectResponse",
                            },
                          ],
                        },
                      },
                      required: ["type", "user"],
                      type: "object",
                    },
                    {
                      additionalProperties: false,
                      properties: {
                        type: {
                          const: "workspace",
                          type: "string",
                        },
                        workspace: {
                          const: true,
                          type: "boolean",
                        },
                      },
                      required: ["type", "workspace"],
                      type: "object",
                    },
                  ],
                },
                workspace_name: {
                  type: ["string", "null"],
                },
              },
              required: ["owner", "workspace_name"],
              type: "object",
            },
          ],
        },
        id: {
          type: ["string"],
        },
        name: {
          type: ["string", "null"],
        },
        object: {
          const: "user",
          type: "string",
        },
        type: {
          const: "bot",
          type: "string",
        },
      },
      required: ["type", "bot", "name", "avatar_url", "id", "object"],
      type: "object",
    },
    EquationRichTextItemResponse: {
      additionalProperties: false,
      properties: {
        annotations: {
          additionalProperties: false,
          properties: {
            bold: {
              type: "boolean",
            },
            code: {
              type: "boolean",
            },
            color: {
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
              type: "string",
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
          },
          required: [
            "bold",
            "italic",
            "strikethrough",
            "underline",
            "code",
            "color",
          ],
          type: "object",
        },
        equation: {
          additionalProperties: false,
          properties: {
            expression: {
              type: "string",
            },
          },
          required: ["expression"],
          type: "object",
        },
        href: {
          type: ["string", "null"],
        },
        plain_text: {
          type: "string",
        },
        type: {
          const: "equation",
          type: "string",
        },
      },
      required: ["type", "equation", "annotations", "plain_text", "href"],
      type: "object",
    },
    MentionRichTextItemResponse: {
      additionalProperties: false,
      properties: {
        annotations: {
          additionalProperties: false,
          properties: {
            bold: {
              type: "boolean",
            },
            code: {
              type: "boolean",
            },
            color: {
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
              type: "string",
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
          },
          required: [
            "bold",
            "italic",
            "strikethrough",
            "underline",
            "code",
            "color",
          ],
          type: "object",
        },
        href: {
          type: ["string", "null"],
        },
        mention: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                type: {
                  const: "user",
                  type: "string",
                },
                user: {
                  anyOf: [
                    {
                      $ref: "#/definitions/PartialUserObjectResponse",
                    },
                    {
                      $ref: "#/definitions/UserObjectResponse",
                    },
                  ],
                },
              },
              required: ["type", "user"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                date: {
                  additionalProperties: false,
                  properties: {
                    end: {
                      type: ["string", "null"],
                    },
                    start: {
                      type: "string",
                    },
                    time_zone: TimeZoneSchema,
                  },
                  required: ["start", "end", "time_zone"],
                  type: "object",
                },
                type: {
                  const: "date",
                  type: "string",
                },
              },
              required: ["type", "date"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                link_preview: {
                  additionalProperties: false,
                  properties: {
                    url: {
                      type: "string",
                    },
                  },
                  required: ["url"],
                  type: "object",
                },
                type: {
                  const: "link_preview",
                  type: "string",
                },
              },
              required: ["type", "link_preview"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                template_mention: {
                  anyOf: [
                    {
                      additionalProperties: false,
                      properties: {
                        template_mention_date: {
                          enum: ["today", "now"],
                          type: "string",
                        },
                        type: {
                          const: "template_mention_date",
                          type: "string",
                        },
                      },
                      required: ["type", "template_mention_date"],
                      type: "object",
                    },
                    {
                      additionalProperties: false,
                      properties: {
                        template_mention_user: {
                          const: "me",
                          type: "string",
                        },
                        type: {
                          const: "template_mention_user",
                          type: "string",
                        },
                      },
                      required: ["type", "template_mention_user"],
                      type: "object",
                    },
                  ],
                },
                type: {
                  const: "template_mention",
                  type: "string",
                },
              },
              required: ["type", "template_mention"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                page: {
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: ["string"],
                    },
                  },
                  required: ["id"],
                  type: "object",
                },
                type: {
                  const: "page",
                  type: "string",
                },
              },
              required: ["type", "page"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                database: {
                  additionalProperties: false,
                  properties: {
                    id: {
                      type: ["string"],
                    },
                  },
                  required: ["id"],
                  type: "object",
                },
                type: {
                  const: "database",
                  type: "string",
                },
              },
              required: ["type", "database"],
              type: "object",
            },
          ],
        },
        plain_text: {
          type: "string",
        },
        type: {
          const: "mention",
          type: "string",
        },
      },
      required: ["type", "mention", "annotations", "plain_text", "href"],
      type: "object",
    },
    PageObjectResponse: {
      additionalProperties: false,
      properties: {
        archived: {
          type: "boolean",
        },
        cover: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                external: {
                  additionalProperties: false,
                  properties: {
                    url: {
                      type: "string",
                    },
                  },
                  required: ["url"],
                  type: "object",
                },
                type: {
                  const: "external",
                  type: "string",
                },
              },
              required: ["type", "external"],
              type: "object",
            },
            {
              type: "null",
            },
            {
              additionalProperties: false,
              properties: {
                file: {
                  additionalProperties: false,
                  properties: {
                    expiry_time: {
                      type: "string",
                    },
                    url: {
                      type: "string",
                    },
                  },
                  required: ["url", "expiry_time"],
                  type: "object",
                },
                type: {
                  const: "file",
                  type: "string",
                },
              },
              required: ["type", "file"],
              type: "object",
            },
          ],
        },
        created_by: {
          $ref: "#/definitions/PartialUserObjectResponse",
        },
        created_time: {
          type: "string",
        },
        icon: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                emoji: EmojisSchema,
                type: {
                  const: "emoji",
                  type: "string",
                },
              },
              required: ["type", "emoji"],
              type: "object",
            },
            {
              type: "null",
            },
            {
              additionalProperties: false,
              properties: {
                external: {
                  additionalProperties: false,
                  properties: {
                    url: {
                      type: "string",
                    },
                  },
                  required: ["url"],
                  type: "object",
                },
                type: {
                  const: "external",
                  type: "string",
                },
              },
              required: ["type", "external"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                file: {
                  additionalProperties: false,
                  properties: {
                    expiry_time: {
                      type: "string",
                    },
                    url: {
                      type: "string",
                    },
                  },
                  required: ["url", "expiry_time"],
                  type: "object",
                },
                type: {
                  const: "file",
                  type: "string",
                },
              },
              required: ["type", "file"],
              type: "object",
            },
          ],
        },
        id: {
          type: "string",
        },
        last_edited_by: {
          $ref: "#/definitions/PartialUserObjectResponse",
        },
        last_edited_time: {
          type: "string",
        },
        object: {
          const: "page",
          type: "string",
        },
        parent: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                database_id: {
                  type: "string",
                },
                type: {
                  const: "database_id",
                  type: "string",
                },
              },
              required: ["type", "database_id"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                page_id: {
                  type: "string",
                },
                type: {
                  const: "page_id",
                  type: "string",
                },
              },
              required: ["type", "page_id"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                block_id: {
                  type: "string",
                },
                type: {
                  const: "block_id",
                  type: "string",
                },
              },
              required: ["type", "block_id"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                type: {
                  const: "workspace",
                  type: "string",
                },
                workspace: {
                  const: true,
                  type: "boolean",
                },
              },
              required: ["type", "workspace"],
              type: "object",
            },
          ],
        },
        properties: {
          additionalProperties: {
            anyOf: [
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  number: {
                    type: ["number", "null"],
                  },
                  type: {
                    const: "number",
                    type: "string",
                  },
                },
                required: ["type", "number", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "url",
                    type: "string",
                  },
                  url: {
                    type: ["string", "null"],
                  },
                },
                required: ["type", "url", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  select: {
                    anyOf: [
                      {
                        additionalProperties: false,
                        properties: {
                          color: {
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
                            ],
                            type: "string",
                          },
                          id: {
                            type: "string",
                          },
                          name: {
                            type: "string",
                          },
                        },
                        required: ["id", "name", "color"],
                        type: "object",
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  type: {
                    const: "select",
                    type: "string",
                  },
                },
                required: ["type", "select", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  multi_select: {
                    items: {
                      additionalProperties: false,
                      properties: {
                        color: {
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
                          ],
                          type: "string",
                        },
                        id: {
                          type: "string",
                        },
                        name: {
                          type: "string",
                        },
                      },
                      required: ["id", "name", "color"],
                      type: "object",
                    },
                    type: "array",
                  },
                  type: {
                    const: "multi_select",
                    type: "string",
                  },
                },
                required: ["type", "multi_select", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  status: {
                    anyOf: [
                      {
                        additionalProperties: false,
                        properties: {
                          color: {
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
                            ],
                            type: "string",
                          },
                          id: {
                            type: "string",
                          },
                          name: {
                            type: "string",
                          },
                        },
                        required: ["id", "name", "color"],
                        type: "object",
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  type: {
                    const: "status",
                    type: "string",
                  },
                },
                required: ["type", "status", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  date: {
                    anyOf: [
                      {
                        additionalProperties: false,
                        properties: {
                          end: {
                            type: ["string", "null"],
                          },
                          start: {
                            type: "string",
                          },
                          time_zone: TimeZoneSchema,
                        },
                        required: ["start", "end", "time_zone"],
                        type: "object",
                      },
                      {
                        type: "null",
                      },
                    ],
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "date",
                    type: "string",
                  },
                },
                required: ["type", "date", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  email: {
                    type: ["string", "null"],
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "email",
                    type: "string",
                  },
                },
                required: ["type", "email", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  phone_number: {
                    type: ["string", "null"],
                  },
                  type: {
                    const: "phone_number",
                    type: "string",
                  },
                },
                required: ["type", "phone_number", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  checkbox: {
                    type: "boolean",
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "checkbox",
                    type: "string",
                  },
                },
                required: ["type", "checkbox", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  files: {
                    items: {
                      anyOf: [
                        {
                          additionalProperties: false,
                          properties: {
                            file: {
                              additionalProperties: false,
                              properties: {
                                expiry_time: {
                                  type: "string",
                                },
                                url: {
                                  type: "string",
                                },
                              },
                              required: ["url", "expiry_time"],
                              type: "object",
                            },
                            name: {
                              type: "string",
                            },
                            type: {
                              const: "file",
                              type: "string",
                            },
                          },
                          required: ["file", "name"],
                          type: "object",
                        },
                        {
                          additionalProperties: false,
                          properties: {
                            external: {
                              additionalProperties: false,
                              properties: {
                                url: {
                                  type: "string",
                                },
                              },
                              required: ["url"],
                              type: "object",
                            },
                            name: {
                              type: "string",
                            },
                            type: {
                              const: "external",
                              type: "string",
                            },
                          },
                          required: ["external", "name"],
                          type: "object",
                        },
                      ],
                    },
                    type: "array",
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "files",
                    type: "string",
                  },
                },
                required: ["type", "files", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  created_by: {
                    anyOf: [
                      {
                        $ref: "#/definitions/PartialUserObjectResponse",
                      },
                      {
                        $ref: "#/definitions/UserObjectResponse",
                      },
                    ],
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "created_by",
                    type: "string",
                  },
                },
                required: ["type", "created_by", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  created_time: {
                    type: "string",
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "created_time",
                    type: "string",
                  },
                },
                required: ["type", "created_time", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  last_edited_by: {
                    anyOf: [
                      {
                        $ref: "#/definitions/PartialUserObjectResponse",
                      },
                      {
                        $ref: "#/definitions/UserObjectResponse",
                      },
                    ],
                  },
                  type: {
                    const: "last_edited_by",
                    type: "string",
                  },
                },
                required: ["type", "last_edited_by", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  last_edited_time: {
                    type: "string",
                  },
                  type: {
                    const: "last_edited_time",
                    type: "string",
                  },
                },
                required: ["type", "last_edited_time", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  formula: {
                    anyOf: [
                      {
                        additionalProperties: false,
                        properties: {
                          string: {
                            type: ["string", "null"],
                          },
                          type: {
                            const: "string",
                            type: "string",
                          },
                        },
                        required: ["type", "string"],
                        type: "object",
                      },
                      {
                        additionalProperties: false,
                        properties: {
                          date: {
                            anyOf: [
                              {
                                additionalProperties: false,
                                properties: {
                                  end: {
                                    type: ["string", "null"],
                                  },
                                  start: {
                                    type: "string",
                                  },
                                  time_zone: TimeZoneSchema,
                                },
                                required: ["start", "end", "time_zone"],
                                type: "object",
                              },
                              {
                                type: "null",
                              },
                            ],
                          },
                          type: {
                            const: "date",
                            type: "string",
                          },
                        },
                        required: ["type", "date"],
                        type: "object",
                      },
                      {
                        additionalProperties: false,
                        properties: {
                          number: {
                            type: ["number", "null"],
                          },
                          type: {
                            const: "number",
                            type: "string",
                          },
                        },
                        required: ["type", "number"],
                        type: "object",
                      },
                      {
                        additionalProperties: false,
                        properties: {
                          boolean: {
                            type: ["boolean", "null"],
                          },
                          type: {
                            const: "boolean",
                            type: "string",
                          },
                        },
                        required: ["type", "boolean"],
                        type: "object",
                      },
                    ],
                  },
                  id: {
                    type: "string",
                  },
                  type: {
                    const: "formula",
                    type: "string",
                  },
                },
                required: ["type", "formula", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  title: {
                    items: {
                      $ref: "#/definitions/RichTextItemResponse",
                    },
                    type: "array",
                  },
                  type: {
                    const: "title",
                    type: "string",
                  },
                },
                required: ["type", "title", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  rich_text: {
                    items: {
                      $ref: "#/definitions/RichTextItemResponse",
                    },
                    type: "array",
                  },
                  type: {
                    const: "rich_text",
                    type: "string",
                  },
                },
                required: ["type", "rich_text", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  people: {
                    items: {
                      anyOf: [
                        {
                          $ref: "#/definitions/PartialUserObjectResponse",
                        },
                        {
                          $ref: "#/definitions/UserObjectResponse",
                        },
                      ],
                    },
                    type: "array",
                  },
                  type: {
                    const: "people",
                    type: "string",
                  },
                },
                required: ["type", "people", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  relation: {
                    items: {
                      additionalProperties: false,
                      properties: {
                        id: {
                          type: "string",
                        },
                      },
                      required: ["id"],
                      type: "object",
                    },
                    type: "array",
                  },
                  type: {
                    const: "relation",
                    type: "string",
                  },
                },
                required: ["type", "relation", "id"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                  },
                  rollup: {
                    anyOf: [
                      {
                        additionalProperties: false,
                        properties: {
                          function: {
                            enum: [
                              "count",
                              "count_values",
                              "empty",
                              "not_empty",
                              "unique",
                              "show_unique",
                              "percent_empty",
                              "percent_not_empty",
                              "sum",
                              "average",
                              "median",
                              "min",
                              "max",
                              "range",
                              "earliest_date",
                              "latest_date",
                              "date_range",
                              "checked",
                              "unchecked",
                              "percent_checked",
                              "percent_unchecked",
                              "count_per_group",
                              "percent_per_group",
                              "show_original",
                            ],
                            type: "string",
                          },
                          number: {
                            type: ["number", "null"],
                          },
                          type: {
                            const: "number",
                            type: "string",
                          },
                        },
                        required: ["type", "number", "function"],
                        type: "object",
                      },
                      {
                        additionalProperties: false,
                        properties: {
                          date: {
                            anyOf: [
                              {
                                additionalProperties: false,
                                properties: {
                                  end: {
                                    type: ["string", "null"],
                                  },
                                  start: {
                                    type: "string",
                                  },
                                  time_zone: TimeZoneSchema,
                                },
                                required: ["start", "end", "time_zone"],
                                type: "object",
                              },
                              {
                                type: "null",
                              },
                            ],
                          },
                          function: {
                            enum: [
                              "count",
                              "count_values",
                              "empty",
                              "not_empty",
                              "unique",
                              "show_unique",
                              "percent_empty",
                              "percent_not_empty",
                              "sum",
                              "average",
                              "median",
                              "min",
                              "max",
                              "range",
                              "earliest_date",
                              "latest_date",
                              "date_range",
                              "checked",
                              "unchecked",
                              "percent_checked",
                              "percent_unchecked",
                              "count_per_group",
                              "percent_per_group",
                              "show_original",
                            ],
                            type: "string",
                          },
                          type: {
                            const: "date",
                            type: "string",
                          },
                        },
                        required: ["type", "date", "function"],
                        type: "object",
                      },
                      {
                        additionalProperties: false,
                        properties: {
                          array: {
                            items: {
                              anyOf: [
                                {
                                  additionalProperties: false,
                                  properties: {
                                    title: {
                                      items: {
                                        $ref: "#/definitions/RichTextItemResponse",
                                      },
                                      type: "array",
                                    },
                                    type: {
                                      const: "title",
                                      type: "string",
                                    },
                                  },
                                  required: ["type", "title"],
                                  type: "object",
                                },
                                {
                                  additionalProperties: false,
                                  properties: {
                                    rich_text: {
                                      items: {
                                        $ref: "#/definitions/RichTextItemResponse",
                                      },
                                      type: "array",
                                    },
                                    type: {
                                      const: "rich_text",
                                      type: "string",
                                    },
                                  },
                                  required: ["type", "rich_text"],
                                  type: "object",
                                },
                                {
                                  additionalProperties: false,
                                  properties: {
                                    people: {
                                      items: {
                                        anyOf: [
                                          {
                                            $ref: "#/definitions/PartialUserObjectResponse",
                                          },
                                          {
                                            $ref: "#/definitions/UserObjectResponse",
                                          },
                                        ],
                                      },
                                      type: "array",
                                    },
                                    type: {
                                      const: "people",
                                      type: "string",
                                    },
                                  },
                                  required: ["type", "people"],
                                  type: "object",
                                },
                                {
                                  additionalProperties: false,
                                  properties: {
                                    relation: {
                                      items: {
                                        additionalProperties: false,
                                        properties: {
                                          id: {
                                            type: "string",
                                          },
                                        },
                                        required: ["id"],
                                        type: "object",
                                      },
                                      type: "array",
                                    },
                                    type: {
                                      const: "relation",
                                      type: "string",
                                    },
                                  },
                                  required: ["type", "relation"],
                                  type: "object",
                                },
                              ],
                            },
                            type: "array",
                          },
                          function: {
                            enum: [
                              "count",
                              "count_values",
                              "empty",
                              "not_empty",
                              "unique",
                              "show_unique",
                              "percent_empty",
                              "percent_not_empty",
                              "sum",
                              "average",
                              "median",
                              "min",
                              "max",
                              "range",
                              "earliest_date",
                              "latest_date",
                              "date_range",
                              "checked",
                              "unchecked",
                              "percent_checked",
                              "percent_unchecked",
                              "count_per_group",
                              "percent_per_group",
                              "show_original",
                            ],
                            type: "string",
                          },
                          type: {
                            const: "array",
                            type: "string",
                          },
                        },
                        required: ["type", "array", "function"],
                        type: "object",
                      },
                    ],
                  },
                  type: {
                    const: "rollup",
                    type: "string",
                  },
                },
                required: ["type", "rollup", "id"],
                type: "object",
              },
            ],
          },
          type: "object",
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
      type: "object",
    },
    PartialUserObjectResponse: {
      additionalProperties: false,
      properties: {
        id: {
          type: ["string"],
        },
        object: {
          const: "user",
          type: "string",
        },
      },
      required: ["id", "object"],
      type: "object",
    },
    PersonUserObjectResponse: {
      additionalProperties: false,
      properties: {
        avatar_url: {
          type: ["string", "null"],
        },
        id: {
          type: ["string"],
        },
        name: {
          type: ["string", "null"],
        },
        object: {
          const: "user",
          type: "string",
        },
        person: {
          additionalProperties: false,
          properties: {
            email: {
              type: "string",
            },
          },
          type: "object",
        },
        type: {
          const: "person",
          type: "string",
        },
      },
      required: ["type", "person", "name", "avatar_url", "id", "object"],
      type: "object",
    },
    RichTextItemResponse: {
      anyOf: [
        {
          $ref: "#/definitions/TextRichTextItemResponse",
        },
        {
          $ref: "#/definitions/MentionRichTextItemResponse",
        },
        {
          $ref: "#/definitions/EquationRichTextItemResponse",
        },
      ],
    },
    TextRichTextItemResponse: {
      additionalProperties: false,
      properties: {
        annotations: {
          additionalProperties: false,
          properties: {
            bold: {
              type: "boolean",
            },
            code: {
              type: "boolean",
            },
            color: {
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
              type: "string",
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
          },
          required: [
            "bold",
            "italic",
            "strikethrough",
            "underline",
            "code",
            "color",
          ],
          type: "object",
        },
        href: {
          type: ["string", "null"],
        },
        plain_text: {
          type: "string",
        },
        text: {
          additionalProperties: false,
          properties: {
            content: {
              type: "string",
            },
            link: {
              anyOf: [
                {
                  additionalProperties: false,
                  properties: {
                    url: {
                      type: "string",
                    },
                  },
                  required: ["url"],
                  type: "object",
                },
                {
                  type: "null",
                },
              ],
            },
          },
          required: ["content", "link"],
          type: "object",
        },
        type: {
          const: "text",
          type: "string",
        },
      },
      required: ["type", "text", "annotations", "plain_text", "href"],
      type: "object",
    },
    UserObjectResponse: {
      anyOf: [
        {
          $ref: "#/definitions/PersonUserObjectResponse",
        },
        {
          $ref: "#/definitions/BotUserObjectResponse",
        },
      ],
    },
  },
};
