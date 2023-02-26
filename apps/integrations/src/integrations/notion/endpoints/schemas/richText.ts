import {
  makeAllPropertiesOptional,
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makePropertiesOptional,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { EmptyObject, IdRequest } from "./common";
import { DateResponse } from "./formula";
import {
  PersonUserObjectResponse,
  PartialUserObjectResponse,
  UserObjectResponse,
  BotUserObjectResponse,
} from "./person";
import { TimeZoneSchema } from "./timezone";

// type TextRequest = string;
export const TextRequest = makeStringSchema("TextRequest", "TextRequest");

// type LinkPreviewMentionResponse = { url: TextRequest };
export const LinkPreviewMentionResponse = makeObjectSchema(
  "LinkPreviewMentionResponse",
  {
    requiredProperties: {
      url: TextRequest,
    },
  }
);

// type TemplateMentionDateTemplateMentionResponse = {
//   type: "template_mention_date";
//   template_mention_date: "today" | "now";
// };
export const TemplateMentionDateTemplateMentionResponse = makeObjectSchema(
  "TemplateMentionDateTemplateMentionResponse",
  {
    requiredProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "template_mention_date",
      }),
      template_mention_date: makeStringSchema(
        "TemplateMentionDate",
        "TemplateMentionDate",
        {
          enum: ["today", "now"],
        }
      ),
    },
  }
);

// type TemplateMentionUserTemplateMentionResponse = {
//   type: "template_mention_user";
//   template_mention_user: "me";
// };
export const TemplateMentionUserTemplateMentionResponse = makeObjectSchema(
  "TemplateMentionUserTemplateMentionResponse",
  {
    requiredProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "template_mention_user",
      }),
      template_mention_user: makeStringSchema(
        "TemplateMentionUser",
        "TemplateMentionUser",
        {
          const: "me",
        }
      ),
    },
  }
);

// type TemplateMentionResponse =
//   | TemplateMentionDateTemplateMentionResponse
//   | TemplateMentionUserTemplateMentionResponse;
export const TemplateMentionResponse = makeOneOf("TemplateMentionResponse", [
  TemplateMentionDateTemplateMentionResponse,
  TemplateMentionUserTemplateMentionResponse,
]);

// type AnnotationResponse = {
//   bold: boolean;
//   italic: boolean;
//   strikethrough: boolean;
//   underline: boolean;
//   code: boolean;
//   color:
//     | "default"
//     | "gray"
//     | "brown"
//     | "orange"
//     | "yellow"
//     | "green"
//     | "blue"
//     | "purple"
//     | "pink"
//     | "red"
//     | "gray_background"
//     | "brown_background"
//     | "orange_background"
//     | "yellow_background"
//     | "green_background"
//     | "blue_background"
//     | "purple_background"
//     | "pink_background"
//     | "red_background";
// };
export const AnnotationResponse = makeObjectSchema("AnnotationResponse", {
  requiredProperties: {
    bold: makeBooleanSchema("Bold", "Bold"),
    italic: makeBooleanSchema("Italic", "Italic"),
    strikethrough: makeBooleanSchema("Strikethrough", "Strikethrough"),
    underline: makeBooleanSchema("Underline", "Underline"),
    code: makeBooleanSchema("Code", "Code"),
    color: makeStringSchema("Color", "Color", {
      enum: [
        "default",
        "gray",
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
    }),
  },
});

export const AnnotationRequest = makeAllPropertiesOptional(AnnotationResponse);

// export type MentionRichTextItemResponse = {
//   type: "mention";
//   mention:
//     | { type: "user"; user: PartialUserObjectResponse | UserObjectResponse }
//     | { type: "date"; date: DateResponse }
//     | { type: "link_preview"; link_preview: LinkPreviewMentionResponse }
//     | { type: "template_mention"; template_mention: TemplateMentionResponse }
//     | { type: "page"; page: { id: IdRequest } }
//     | { type: "database"; database: { id: IdRequest } };
//   annotations: AnnotationResponse;
//   plain_text: string;
//   href: string | null;
// };
export const MentionRichTextItemResponse = makeObjectSchema(
  "MentionRichTextItemResponse",
  {
    requiredProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "mention",
      }),
      mention: makeOneOf("Mention", [
        makeObjectSchema("UserMention", {
          requiredProperties: {
            type: makeStringSchema("Type", "Type", {
              const: "user",
            }),
            user: makeOneOf("User", [
              PartialUserObjectResponse,
              UserObjectResponse,
            ]),
          },
        }),
        makeObjectSchema("DateMention", {
          requiredProperties: {
            type: makeStringSchema("Type", "Type", {
              const: "date",
            }),
            date: DateResponse,
          },
        }),
        makeObjectSchema("LinkPreviewMention", {
          requiredProperties: {
            type: makeStringSchema("Type", "Type", {
              const: "link_preview",
            }),
            link_preview: LinkPreviewMentionResponse,
          },
        }),
        makeObjectSchema("TemplateMention", {
          requiredProperties: {
            type: makeStringSchema("Type", "Type", {
              const: "template_mention",
            }),
            template_mention: TemplateMentionResponse,
          },
        }),
        makeObjectSchema("PageMention", {
          requiredProperties: {
            type: makeStringSchema("Type", "Type", {
              const: "page",
            }),
            page: makeObjectSchema("Page", {
              requiredProperties: {
                id: IdRequest,
              },
            }),
          },
        }),
        makeObjectSchema("DatabaseMention", {
          requiredProperties: {
            type: makeStringSchema("Type", "Type", {
              const: "database",
            }),
            database: makeObjectSchema("Database", {
              requiredProperties: {
                id: IdRequest,
              },
            }),
          },
        }),
      ]),
      annotations: AnnotationResponse,
      plain_text: makeStringSchema("PlainText", "PlainText"),
      href: makeNullable(makeStringSchema("Href", "Href")),
    },
  }
);

// { id: IdRequest }
const UserIdSchema = makeObjectSchema("User", {
  requiredProperties: {
    id: IdRequest,
  },
});

// {
//   person: { email?: string }
//   id: IdRequest
//   type?: "person"
//   name?: string | null
//   avatar_url?: string | null
//   object?: "user"
// }
const UserPersonRequestSchema = makePropertiesOptional(
  PersonUserObjectResponse,
  ["type", "name", "avatar_url", "object"]
);

// {
//   bot:
//     | EmptyObject
//     | {
//         owner:
//           | {
//               type: "user"
//               user:
//                 | {
//                     type: "person"
//                     person: { email: string }
//                     name: string | null
//                     avatar_url: string | null
//                     id: IdRequest
//                     object: "user"
//                   }
//                 | PartialUserObjectResponse
//             }
//           | { type: "workspace"; workspace: true }
//         workspace_name: string | null
//       }
//   id: IdRequest
//   type?: "bot"
//   name?: string | null
//   avatar_url?: string | null
//   object?: "user"
// }
const BotRequestSchema = makePropertiesOptional(BotUserObjectResponse, [
  "type",
  "name",
  "avatar_url",
  "object",
]);

// type DateRequest = {
//   start: string
//   end?: string | null
//   time_zone?: TimeZoneRequest | null
// }
export const DateRequest = makeObjectSchema("DateRequest", {
  requiredProperties: {
    start: makeStringSchema("Start", "Start"),
  },
  optionalProperties: {
    end: makeNullable(makeStringSchema("End", "End")),
    time_zone: makeNullable(TimeZoneSchema),
  },
});

// type MentionRichTextItemRequest = {
//   mention:
//     | {
//         user:
//           | { id: IdRequest }
//           | {
//               person: { email?: string }
//               id: IdRequest
//               type?: "person"
//               name?: string | null
//               avatar_url?: string | null
//               object?: "user"
//             }
//           | {
//               bot:
//                 | EmptyObject
//                 | {
//                     owner:
//                       | {
//                           type: "user"
//                           user:
//                             | {
//                                 type: "person"
//                                 person: { email: string }
//                                 name: string | null
//                                 avatar_url: string | null
//                                 id: IdRequest
//                                 object: "user"
//                               }
//                             | PartialUserObjectResponse
//                         }
//                       | { type: "workspace"; workspace: true }
//                     workspace_name: string | null
//                   }
//               id: IdRequest
//               type?: "bot"
//               name?: string | null
//               avatar_url?: string | null
//               object?: "user"
//             }
//       }
//     | { date: DateRequest }
//     | { page: { id: IdRequest } }
//     | { database: { id: IdRequest } }
//   type?: "mention"
//   annotations?: {
//     bold?: boolean
//     italic?: boolean
//     strikethrough?: boolean
//     underline?: boolean
//     code?: boolean
//     color?:
//       | "default"
//       | "gray"
//       | "brown"
//       | "orange"
//       | "yellow"
//       | "green"
//       | "blue"
//       | "purple"
//       | "pink"
//       | "red"
//       | "gray_background"
//       | "brown_background"
//       | "orange_background"
//       | "yellow_background"
//       | "green_background"
//       | "blue_background"
//       | "purple_background"
//       | "pink_background"
//       | "red_background"
//   }
// }
export const MentionRichTextItemRequest = makeObjectSchema(
  "MentionRichTextItemRequest",
  {
    requiredProperties: {
      mention: makeOneOf("Mention", [
        makeObjectSchema("UserMention", {
          requiredProperties: {
            user: makeOneOf("User", [UserIdSchema, UserPersonRequestSchema]),
          },
        }),
        makeObjectSchema("BotMention", {
          requiredProperties: {
            bot: makeOneOf("Bot", [EmptyObject, BotRequestSchema]),
            id: IdRequest,
          },
        }),
        makeObjectSchema("DateMention", {
          requiredProperties: {
            date: DateRequest,
          },
        }),
        makeObjectSchema("PageMention", {
          requiredProperties: {
            page: makeObjectSchema("Page", {
              requiredProperties: {
                id: IdRequest,
              },
            }),
          },
        }),
        makeObjectSchema("DatabaseMention", {
          requiredProperties: {
            database: makeObjectSchema("Database", {
              requiredProperties: {
                id: IdRequest,
              },
            }),
          },
        }),
      ]),
    },
    optionalProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "mention",
      }),
      annotations: AnnotationRequest,
    },
  }
);

// export type EquationRichTextItemResponse = {
//   type: "equation";
//   equation: { expression: TextRequest };
//   annotations: AnnotationResponse;
//   plain_text: string;
//   href: string | null;
// };
export const EquationRichTextItemResponse = makeObjectSchema(
  "EquationRichTextItemResponse",
  {
    requiredProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "equation",
      }),
      equation: makeObjectSchema("Equation", {
        requiredProperties: {
          expression: TextRequest,
        },
      }),
      annotations: AnnotationResponse,
      plain_text: makeStringSchema("PlainText", "PlainText"),
      href: makeNullable(makeStringSchema("Href", "Href")),
    },
  }
);

export const EquationRichTextItemRequest = makePropertiesOptional(
  EquationRichTextItemResponse,
  ["type", "annotations"]
);

const TextPropertySchema = makeObjectSchema("Text", {
  requiredProperties: {
    content: makeStringSchema("Content", "Content"),
    link: makeNullable(
      makeObjectSchema("Link", {
        requiredProperties: {
          url: TextRequest,
        },
      })
    ),
  },
});

// export type TextRichTextItemResponse = {
//   type: "text";
//   text: { content: string; link: { url: TextRequest } | null };
//   annotations: AnnotationResponse;
//   plain_text: string;
//   href: string | null;
// };
export const TextRichTextItemResponse = makeObjectSchema(
  "TextRichTextItemResponse",
  {
    requiredProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "text",
      }),
      text: TextPropertySchema,
      annotations: AnnotationResponse,
      plain_text: makeStringSchema("PlainText", "PlainText"),
      href: makeNullable(makeStringSchema("Href", "Href")),
    },
  }
);

export const TextRichTextItemRequest = makeObjectSchema(
  "TextRichTextItemRequest",
  {
    requiredProperties: {
      text: makePropertiesOptional(TextPropertySchema, ["link"]),
      annotations: makeAllPropertiesOptional(AnnotationResponse),
    },
    optionalProperties: {
      type: makeStringSchema("Type", "Type", {
        const: "text",
      }),
    },
  }
);

// export type RichTextItemResponse =
//   | TextRichTextItemResponse
//   | MentionRichTextItemResponse
//   | EquationRichTextItemResponse;
export const RichTextItemResponse = makeOneOf("RichTextItemResponse", [
  TextRichTextItemResponse,
  MentionRichTextItemResponse,
  EquationRichTextItemResponse,
]);

export const RichTextItemRequest = makeOneOf("RichTextItemRequest", [
  TextRichTextItemRequest,
  MentionRichTextItemRequest,
  EquationRichTextItemRequest,
]);
