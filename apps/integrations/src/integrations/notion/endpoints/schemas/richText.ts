import {
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { IdRequest } from "./common";
import { DateResponse } from "./formula";
import { PartialUserObjectResponse, UserObjectResponse } from "./person";

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
      text: makeObjectSchema("Text", {
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
      }),
      annotations: AnnotationResponse,
      plain_text: makeStringSchema("PlainText", "PlainText"),
      href: makeNullable(makeStringSchema("Href", "Href")),
    },
  }
);

// export type RichTextItemResponse =
//   | TextRichTextItemResponse
//   | MentionRichTextItemResponse
//   | EquationRichTextItemResponse;
export const RichTextItemResponse = makeOneOf("RichTextItem", [
  TextRichTextItemResponse,
  MentionRichTextItemResponse,
  EquationRichTextItemResponse,
]);
