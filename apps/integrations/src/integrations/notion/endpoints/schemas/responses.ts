import { JSONSchema } from "core/schemas/types";
import { IdRequest, SelectColor, StringRequest } from "./common";
import { PartialUserObjectResponse, UserObjectResponse } from "./person";
import { TextRequest } from "./requests";
import { TimeZoneRequest } from "./timezone";

export const SelectPropertyResponse: JSONSchema = {
  type: "object",
  properties: {
    id: StringRequest,
    name: StringRequest,
    color: SelectColor,
  },
  required: ["id", "name", "color"],
  additionalProperties: false,
};

export const DateResponse: JSONSchema = {
  type: "object",
  properties: {
    start: {
      type: "string",
    },
    end: {
      type: ["string", "null"],
    },
    time_zone: {
      anyOf: [
        TimeZoneRequest,
        {
          type: "null",
        },
      ],
    },
  },
  required: ["start", "end", "time_zone"],
  additionalProperties: false,
};

export const StringFormulaPropertyResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "string",
    },
    string: {
      type: ["string", "null"],
    },
  },
  required: ["type", "string"],
  additionalProperties: false,
};

export const DateFormulaPropertyResponse: JSONSchema = {
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
  },
  required: ["type", "date"],
  additionalProperties: false,
};

export const NumberFormulaPropertyResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "number",
    },
    number: {
      type: ["number", "null"],
    },
  },
  required: ["type", "number"],
  additionalProperties: false,
};

export const BooleanFormulaPropertyResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "boolean",
    },
    boolean: {
      type: ["boolean", "null"],
    },
  },
  required: ["type", "boolean"],
  additionalProperties: false,
};

export const FormulaPropertyResponse: JSONSchema = {
  anyOf: [
    StringFormulaPropertyResponse,
    DateFormulaPropertyResponse,
    NumberFormulaPropertyResponse,
    BooleanFormulaPropertyResponse,
  ],
};

export const AnnotationResponse: JSONSchema = {
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
  required: ["bold", "italic", "strikethrough", "underline", "code", "color"],
  additionalProperties: false,
};

export const TextRichTextItemResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "text",
    },
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
      required: ["content", "link"],
      additionalProperties: false,
    },
    annotations: AnnotationResponse,
    plain_text: {
      type: "string",
    },
    href: {
      type: ["string", "null"],
    },
  },
  required: ["type", "text", "annotations", "plain_text", "href"],
  additionalProperties: false,
};

export const LinkPreviewMentionResponse: JSONSchema = {
  type: "object",
  properties: {
    url: TextRequest,
  },
  required: ["url"],
  additionalProperties: false,
};

export const TemplateMentionDateTemplateMentionResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "template_mention_date",
    },
    template_mention_date: {
      type: "string",
      enum: ["today", "now"],
    },
  },
  required: ["type", "template_mention_date"],
  additionalProperties: false,
};

export const TemplateMentionUserTemplateMentionResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "template_mention_user",
    },
    template_mention_user: {
      type: "string",
      const: "me",
    },
  },
  required: ["type", "template_mention_user"],
  additionalProperties: false,
};

export const TemplateMentionResponse: JSONSchema = {
  anyOf: [
    TemplateMentionDateTemplateMentionResponse,
    TemplateMentionUserTemplateMentionResponse,
  ],
};

export const MentionRichTextItemResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "mention",
    },
    mention: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "user",
            },
            user: {
              anyOf: [PartialUserObjectResponse, UserObjectResponse],
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
              const: "date",
            },
            date: DateResponse,
          },
          required: ["type", "date"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "link_preview",
            },
            link_preview: LinkPreviewMentionResponse,
          },
          required: ["type", "link_preview"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "template_mention",
            },
            template_mention: TemplateMentionResponse,
          },
          required: ["type", "template_mention"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "page",
            },
            page: {
              type: "object",
              properties: {
                id: IdRequest,
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
          required: ["type", "page"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "database",
            },
            database: {
              type: "object",
              properties: {
                id: IdRequest,
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
          required: ["type", "database"],
          additionalProperties: false,
        },
      ],
    },
    annotations: AnnotationResponse,
    plain_text: {
      type: "string",
    },
    href: {
      type: ["string", "null"],
    },
  },
  required: ["type", "mention", "annotations", "plain_text", "href"],
  additionalProperties: false,
};

export const EquationRichTextItemResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "equation",
    },
    equation: {
      type: "object",
      properties: {
        expression: TextRequest,
      },
      required: ["expression"],
      additionalProperties: false,
    },
    annotations: AnnotationResponse,
    plain_text: {
      type: "string",
    },
    href: {
      type: ["string", "null"],
    },
  },
  required: ["type", "equation", "annotations", "plain_text", "href"],
  additionalProperties: false,
};

export const RichTextItemResponse: JSONSchema = {
  anyOf: [
    TextRichTextItemResponse,
    MentionRichTextItemResponse,
    EquationRichTextItemResponse,
  ],
};
