import { JSONSchema } from "core/schemas/types";
import { SelectColorSchema } from "./common";
import {
  PartialUserObjectResponseSchema,
  UserObjectResponseSchema,
} from "./user";
import {
  EmptyObjectSchema,
  IdRequestSchema,
  StringRequestSchema,
} from "./primitives";
import { TimeZoneRequestSchema } from "./timezone";

export const SelectPropertyResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    id: StringRequestSchema,
    name: StringRequestSchema,
    color: SelectColorSchema,
  },
  required: ["id", "name", "color"],
  additionalProperties: false,
};

export const DateResponseSchema: JSONSchema = {
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
        TimeZoneRequestSchema,
        {
          type: "null",
        },
      ],
    },
  },
  required: ["start", "end", "time_zone"],
  additionalProperties: false,
};

export const TextRequestSchema: JSONSchema = {
  type: "string",
};

export const StringFormulaPropertyResponseSchema: JSONSchema = {
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

export const DateFormulaPropertyResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "date",
    },
    date: {
      anyOf: [
        DateResponseSchema,
        {
          type: "null",
        },
      ],
    },
  },
  required: ["type", "date"],
  additionalProperties: false,
};

export const NumberFormulaPropertyResponseSchema: JSONSchema = {
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

export const BooleanFormulaPropertyResponseSchema: JSONSchema = {
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

export const FormulaPropertyResponseSchema: JSONSchema = {
  anyOf: [
    StringFormulaPropertyResponseSchema,
    DateFormulaPropertyResponseSchema,
    NumberFormulaPropertyResponseSchema,
    BooleanFormulaPropertyResponseSchema,
  ],
};

export const AnnotationResponseSchema: JSONSchema = {
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

export const TextRichTextItemResponseSchema: JSONSchema = {
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
                url: TextRequestSchema,
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
    annotations: AnnotationResponseSchema,
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

export const LinkPreviewMentionResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    url: TextRequestSchema,
  },
  required: ["url"],
  additionalProperties: false,
};

export const TemplateMentionDateTemplateMentionResponseSchema: JSONSchema = {
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

export const TemplateMentionUserTemplateMentionResponseSchema: JSONSchema = {
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

export const TemplateMentionResponseSchema: JSONSchema = {
  anyOf: [
    TemplateMentionDateTemplateMentionResponseSchema,
    TemplateMentionUserTemplateMentionResponseSchema,
  ],
};

export const MentionRichTextItemResponseSchema: JSONSchema = {
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
              anyOf: [
                PartialUserObjectResponseSchema,
                UserObjectResponseSchema,
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
              const: "date",
            },
            date: DateResponseSchema,
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
            link_preview: LinkPreviewMentionResponseSchema,
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
            template_mention: TemplateMentionResponseSchema,
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
                id: IdRequestSchema,
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
                id: IdRequestSchema,
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
    annotations: AnnotationResponseSchema,
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

export const EquationRichTextItemResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "equation",
    },
    equation: {
      type: "object",
      properties: {
        expression: TextRequestSchema,
      },
      required: ["expression"],
      additionalProperties: false,
    },
    annotations: AnnotationResponseSchema,
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

export const RichTextItemResponseSchema: JSONSchema = {
  anyOf: [
    TextRichTextItemResponseSchema,
    MentionRichTextItemResponseSchema,
    EquationRichTextItemResponseSchema,
  ],
};

export const RollupFunctionSchema: JSONSchema = {
  type: "string",
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
};

export const NumberFormatSchema: JSONSchema = {
  type: "string",
  enum: [
    "number",
    "number_with_commas",
    "percent",
    "dollar",
    "canadian_dollar",
    "singapore_dollar",
    "euro",
    "pound",
    "yen",
    "ruble",
    "rupee",
    "won",
    "yuan",
    "real",
    "lira",
    "rupiah",
    "franc",
    "hong_kong_dollar",
    "new_zealand_dollar",
    "krona",
    "norwegian_krone",
    "mexican_peso",
    "rand",
    "new_taiwan_dollar",
    "danish_krone",
    "zloty",
    "baht",
    "forint",
    "koruna",
    "shekel",
    "chilean_peso",
    "philippine_peso",
    "dirham",
    "colombian_peso",
    "riyal",
    "ringgit",
    "leu",
    "argentine_peso",
    "uruguayan_peso",
  ],
};

export const StatusPropertyResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    id: StringRequestSchema,
    name: StringRequestSchema,
    color: SelectColorSchema,
  },
  required: ["id", "name", "color"],
  additionalProperties: false,
};

export const LanguageRequestSchema: JSONSchema = {
  type: "string",
  enum: [
    "abap",
    "agda",
    "arduino",
    "assembly",
    "bash",
    "basic",
    "bnf",
    "c",
    "c#",
    "c++",
    "clojure",
    "coffeescript",
    "coq",
    "css",
    "dart",
    "dhall",
    "diff",
    "docker",
    "ebnf",
    "elixir",
    "elm",
    "erlang",
    "f#",
    "flow",
    "fortran",
    "gherkin",
    "glsl",
    "go",
    "graphql",
    "groovy",
    "haskell",
    "html",
    "idris",
    "java",
    "javascript",
    "json",
    "julia",
    "kotlin",
    "latex",
    "less",
    "lisp",
    "livescript",
    "llvm ir",
    "lua",
    "makefile",
    "markdown",
    "markup",
    "matlab",
    "mathematica",
    "mermaid",
    "nix",
    "objective-c",
    "ocaml",
    "pascal",
    "perl",
    "php",
    "plain text",
    "powershell",
    "prolog",
    "protobuf",
    "purescript",
    "python",
    "r",
    "racket",
    "reason",
    "ruby",
    "rust",
    "sass",
    "scala",
    "scheme",
    "scss",
    "shell",
    "solidity",
    "sql",
    "swift",
    "toml",
    "typescript",
    "vb.net",
    "verilog",
    "vhdl",
    "visual basic",
    "webassembly",
    "xml",
    "yaml",
    "java/c/c++/c#",
  ],
};

export const CodeBlockObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "code",
    },
    code: {
      type: "object",
      properties: {
        rich_text: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        caption: {
          type: "array",
          items: RichTextItemResponseSchema,
        },
        language: LanguageRequestSchema,
      },
      required: ["rich_text", "caption", "language"],
      additionalProperties: false,
    },
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
    object: {
      type: "string",
      const: "block",
    },
    id: {
      type: "string",
    },
    created_time: {
      type: "string",
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_time: {
      type: "string",
    },
    last_edited_by: PartialUserObjectResponseSchema,
    has_children: {
      type: "boolean",
    },
    archived: {
      type: "boolean",
    },
  },
  required: [
    "type",
    "code",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived",
  ],
  additionalProperties: false,
};

export const NumberPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "number",
    },
    number: {
      type: ["number", "null"],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "number", "object", "id"],
  additionalProperties: false,
};

export const UrlPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "url",
    },
    url: {
      type: ["string", "null"],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "url", "object", "id"],
  additionalProperties: false,
};

export const SelectPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "select",
    },
    select: {
      anyOf: [
        SelectPropertyResponseSchema,
        {
          type: "null",
        },
      ],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "select", "object", "id"],
  additionalProperties: false,
};

export const MultiSelectPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "multi_select",
    },
    multi_select: {
      type: "array",
      items: SelectPropertyResponseSchema,
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "multi_select", "object", "id"],
  additionalProperties: false,
};

export const StatusPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "status",
    },
    status: {
      anyOf: [
        SelectPropertyResponseSchema,
        {
          type: "null",
        },
      ],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "status", "object", "id"],
  additionalProperties: false,
};

export const DatePropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "date",
    },
    date: {
      anyOf: [
        DateResponseSchema,
        {
          type: "null",
        },
      ],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "date", "object", "id"],
  additionalProperties: false,
};

export const EmailPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "email",
    },
    email: {
      type: ["string", "null"],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "email", "object", "id"],
  additionalProperties: false,
};

export const PhoneNumberPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "phone_number",
    },
    phone_number: {
      type: ["string", "null"],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "phone_number", "object", "id"],
  additionalProperties: false,
};

export const CheckboxPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "checkbox",
    },
    checkbox: {
      type: "boolean",
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "checkbox", "object", "id"],
  additionalProperties: false,
};

export const FilesPropertyItemObjectResponseSchema: JSONSchema = {
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
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "files", "object", "id"],
  additionalProperties: false,
};

export const CreatedByPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "created_by",
    },
    created_by: {
      anyOf: [PartialUserObjectResponseSchema, UserObjectResponseSchema],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "created_by", "object", "id"],
  additionalProperties: false,
};

export const CreatedTimePropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "created_time",
    },
    created_time: {
      type: "string",
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "created_time", "object", "id"],
  additionalProperties: false,
};

export const LastEditedByPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "last_edited_by",
    },
    last_edited_by: {
      anyOf: [PartialUserObjectResponseSchema, UserObjectResponseSchema],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "last_edited_by", "object", "id"],
  additionalProperties: false,
};

export const LastEditedTimePropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "last_edited_time",
    },
    last_edited_time: {
      type: "string",
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "last_edited_time", "object", "id"],
  additionalProperties: false,
};

export const FormulaPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "formula",
    },
    formula: FormulaPropertyResponseSchema,
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "formula", "object", "id"],
  additionalProperties: false,
};

export const TitlePropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "title",
    },
    title: RichTextItemResponseSchema,
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "title", "object", "id"],
  additionalProperties: false,
};

export const RichTextPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "rich_text",
    },
    rich_text: RichTextItemResponseSchema,
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "rich_text", "object", "id"],
  additionalProperties: false,
};

export const PeoplePropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "people",
    },
    people: {
      anyOf: [PartialUserObjectResponseSchema, UserObjectResponseSchema],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "people", "object", "id"],
  additionalProperties: false,
};

export const RelationPropertyItemObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "relation",
    },
    relation: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "relation", "object", "id"],
  additionalProperties: false,
};

export const RollupPropertyItemObjectResponseSchema: JSONSchema = {
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
            function: RollupFunctionSchema,
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
                DateResponseSchema,
                {
                  type: "null",
                },
              ],
            },
            function: RollupFunctionSchema,
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
              items: EmptyObjectSchema,
            },
            function: RollupFunctionSchema,
          },
          required: ["type", "array", "function"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "unsupported",
            },
            unsupported: EmptyObjectSchema,
            function: RollupFunctionSchema,
          },
          required: ["type", "unsupported", "function"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "incomplete",
            },
            incomplete: EmptyObjectSchema,
            function: RollupFunctionSchema,
          },
          required: ["type", "incomplete", "function"],
          additionalProperties: false,
        },
      ],
    },
    object: {
      type: "string",
      const: "property_item",
    },
    id: {
      type: "string",
    },
  },
  required: ["type", "rollup", "object", "id"],
  additionalProperties: false,
};

export const PropertyItemObjectResponseSchema: JSONSchema = {
  anyOf: [
    NumberPropertyItemObjectResponseSchema,
    UrlPropertyItemObjectResponseSchema,
    SelectPropertyItemObjectResponseSchema,
    MultiSelectPropertyItemObjectResponseSchema,
    StatusPropertyItemObjectResponseSchema,
    DatePropertyItemObjectResponseSchema,
    EmailPropertyItemObjectResponseSchema,
    PhoneNumberPropertyItemObjectResponseSchema,
    CheckboxPropertyItemObjectResponseSchema,
    FilesPropertyItemObjectResponseSchema,
    CreatedByPropertyItemObjectResponseSchema,
    CreatedTimePropertyItemObjectResponseSchema,
    LastEditedByPropertyItemObjectResponseSchema,
    LastEditedTimePropertyItemObjectResponseSchema,
    FormulaPropertyItemObjectResponseSchema,
    TitlePropertyItemObjectResponseSchema,
    RichTextPropertyItemObjectResponseSchema,
    PeoplePropertyItemObjectResponseSchema,
    RelationPropertyItemObjectResponseSchema,
    RollupPropertyItemObjectResponseSchema,
  ],
};

export const CommentObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    object: {
      type: "string",
      const: "comment",
    },
    id: {
      type: "string",
    },
    parent: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "page_id",
            },
            page_id: IdRequestSchema,
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
            block_id: IdRequestSchema,
          },
          required: ["type", "block_id"],
          additionalProperties: false,
        },
      ],
    },
    discussion_id: {
      type: "string",
    },
    rich_text: {
      type: "array",
      items: RichTextItemResponseSchema,
    },
    created_by: PartialUserObjectResponseSchema,
    created_time: {
      type: "string",
    },
    last_edited_time: {
      type: "string",
    },
  },
  required: [
    "object",
    "id",
    "parent",
    "discussion_id",
    "rich_text",
    "created_by",
    "created_time",
    "last_edited_time",
  ],
  additionalProperties: false,
};

export const PartialCommentObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    object: {
      type: "string",
      const: "comment",
    },
    id: {
      type: "string",
    },
  },
  required: ["object", "id"],
  additionalProperties: false,
};

export const PropertyItemPropertyItemListResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "property_item",
    },
    property_item: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "title",
            },
            title: EmptyObjectSchema,
            next_url: {
              type: ["string", "null"],
            },
            id: {
              type: "string",
            },
          },
          required: ["type", "title", "next_url", "id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "rich_text",
            },
            rich_text: EmptyObjectSchema,
            next_url: {
              type: ["string", "null"],
            },
            id: {
              type: "string",
            },
          },
          required: ["type", "rich_text", "next_url", "id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "people",
            },
            people: EmptyObjectSchema,
            next_url: {
              type: ["string", "null"],
            },
            id: {
              type: "string",
            },
          },
          required: ["type", "people", "next_url", "id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "relation",
            },
            relation: EmptyObjectSchema,
            next_url: {
              type: ["string", "null"],
            },
            id: {
              type: "string",
            },
          },
          required: ["type", "relation", "next_url", "id"],
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
                    function: RollupFunctionSchema,
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
                        DateResponseSchema,
                        {
                          type: "null",
                        },
                      ],
                    },
                    function: RollupFunctionSchema,
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
                      items: EmptyObjectSchema,
                    },
                    function: RollupFunctionSchema,
                  },
                  required: ["type", "array", "function"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      const: "unsupported",
                    },
                    unsupported: EmptyObjectSchema,
                    function: RollupFunctionSchema,
                  },
                  required: ["type", "unsupported", "function"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      const: "incomplete",
                    },
                    incomplete: EmptyObjectSchema,
                    function: RollupFunctionSchema,
                  },
                  required: ["type", "incomplete", "function"],
                  additionalProperties: false,
                },
              ],
            },
            next_url: {
              type: ["string", "null"],
            },
            id: {
              type: "string",
            },
          },
          required: ["type", "rollup", "next_url", "id"],
          additionalProperties: false,
        },
      ],
    },
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
      items: PropertyItemObjectResponseSchema,
    },
  },
  required: [
    "type",
    "property_item",
    "object",
    "next_cursor",
    "has_more",
    "results",
  ],
  additionalProperties: false,
};

export const PropertyItemListResponseSchema: JSONSchema =
  PropertyItemPropertyItemListResponseSchema;

export const DateRequestSchema: JSONSchema = {
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
        TimeZoneRequestSchema,
        {
          type: "null",
        },
      ],
    },
  },
  required: ["start"],
  additionalProperties: false,
};

export const RichTextItemRequestSchema: JSONSchema = {
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
                    url: TextRequestSchema,
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
              required: ["user"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                date: DateRequestSchema,
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
                    id: IdRequestSchema,
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
                    id: IdRequestSchema,
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
            expression: TextRequestSchema,
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
