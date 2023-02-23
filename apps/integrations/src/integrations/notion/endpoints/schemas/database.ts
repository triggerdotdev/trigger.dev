import { JSONSchema } from "core/schemas/types";
import { SelectColorSchema } from "./common";
import { EmojisSchema } from "./emojis";
import { PartialUserObjectResponseSchema } from "./user";
import {
  StringRequestSchema,
  EmptyObjectSchema,
  IdRequestSchema,
} from "./primitives";
import {
  NumberFormatSchema,
  RichTextItemResponseSchema,
  RollupFunctionSchema,
  SelectPropertyResponseSchema,
  TextRequestSchema,
  StatusPropertyResponseSchema
} from "./properties";
import { SelectColorSchema } from "./common";
import {
  PartialUserObjectResponseSchema,
  UserObjectResponseSchema,
} from "./user";
import { TimeZoneRequestSchema } from "./timezone";

export const NumberDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "number",
    },
    number: {
      type: "object",
      properties: {
        format: NumberFormatSchema,
      },
      required: ["format"],
      additionalProperties: false,
    },
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "number", "id", "name"],
  additionalProperties: false,
};

export const FormulaDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "formula",
    },
    formula: {
      type: "object",
      properties: {
        expression: {
          type: "string",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "formula", "id", "name"],
  additionalProperties: false,
};

export const SelectDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "select",
    },
    select: {
      type: "object",
      properties: {
        options: {
          type: "array",
          items: SelectPropertyResponseSchema,
        },
      },
      required: ["options"],
      additionalProperties: false,
    },
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "select", "id", "name"],
  additionalProperties: false,
};

export const MultiSelectDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "multi_select",
    },
    multi_select: {
      type: "object",
      properties: {
        options: {
          type: "array",
          items: SelectPropertyResponseSchema,
        },
      },
      required: ["options"],
      additionalProperties: false,
    },
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "multi_select", "id", "name"],
  additionalProperties: false,
};

export const StatusDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "status",
    },
    status: {
      type: "object",
      properties: {
        options: {
          type: "array",
          items: StatusPropertyResponseSchema,
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: StringRequestSchema,
              name: StringRequestSchema,
              color: SelectColorSchema,
              option_ids: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["id", "name", "color", "option_ids"],
            additionalProperties: false,
          },
        },
      },
      required: ["options", "groups"],
      additionalProperties: false,
    },
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "status", "id", "name"],
  additionalProperties: false,
};

export const SinglePropertyDatabasePropertyRelationConfigResponseSchema: JSONSchema =
  {
    type: "object",
    properties: {
      type: {
        type: "string",
        const: "single_property",
      },
      single_property: EmptyObjectSchema,
      database_id: IdRequestSchema,
    },
    required: ["type", "single_property", "database_id"],
    additionalProperties: false,
  };

export const DualPropertyDatabasePropertyRelationConfigResponseSchema: JSONSchema =
  {
    type: "object",
    properties: {
      type: {
        type: "string",
        const: "dual_property",
      },
      dual_property: {
        type: "object",
        properties: {
          synced_property_id: StringRequestSchema,
          synced_property_name: StringRequestSchema,
        },
        required: ["synced_property_id", "synced_property_name"],
        additionalProperties: false,
      },
      database_id: IdRequestSchema,
    },
    required: ["type", "dual_property", "database_id"],
    additionalProperties: false,
  };

export const DatabasePropertyRelationConfigResponseSchema: JSONSchema = {
  anyOf: [
    SinglePropertyDatabasePropertyRelationConfigResponseSchema,
    DualPropertyDatabasePropertyRelationConfigResponseSchema,
  ],
};

export const RelationDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "relation",
    },
    relation: DatabasePropertyRelationConfigResponseSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "relation", "id", "name"],
  additionalProperties: false,
};

export const RollupDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "rollup",
    },
    rollup: {
      type: "object",
      properties: {
        rollup_property_name: {
          type: "string",
        },
        relation_property_name: {
          type: "string",
        },
        rollup_property_id: {
          type: "string",
        },
        relation_property_id: {
          type: "string",
        },
        function: RollupFunctionSchema,
      },
      required: [
        "rollup_property_name",
        "relation_property_name",
        "rollup_property_id",
        "relation_property_id",
        "function",
      ],
      additionalProperties: false,
    },
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "rollup", "id", "name"],
  additionalProperties: false,
};

export const TitleDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "title",
    },
    title: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "title", "id", "name"],
  additionalProperties: false,
};

export const RichTextDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "rich_text",
    },
    rich_text: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "rich_text", "id", "name"],
  additionalProperties: false,
};

export const UrlDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "url",
    },
    url: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "url", "id", "name"],
  additionalProperties: false,
};

export const PeopleDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "people",
    },
    people: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "people", "id", "name"],
  additionalProperties: false,
};

export const FilesDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "files",
    },
    files: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "files", "id", "name"],
  additionalProperties: false,
};

export const EmailDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "email",
    },
    email: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "email", "id", "name"],
  additionalProperties: false,
};

export const PhoneNumberDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "phone_number",
    },
    phone_number: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "phone_number", "id", "name"],
  additionalProperties: false,
};

export const DateDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "date",
    },
    date: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "date", "id", "name"],
  additionalProperties: false,
};

export const CheckboxDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "checkbox",
    },
    checkbox: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "checkbox", "id", "name"],
  additionalProperties: false,
};

export const CreatedByDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "created_by",
    },
    created_by: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "created_by", "id", "name"],
  additionalProperties: false,
};

export const CreatedTimeDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "created_time",
    },
    created_time: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "created_time", "id", "name"],
  additionalProperties: false,
};

export const LastEditedByDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "last_edited_by",
    },
    last_edited_by: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "last_edited_by", "id", "name"],
  additionalProperties: false,
};

export const LastEditedTimeDatabasePropertyConfigResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "last_edited_time",
    },
    last_edited_time: EmptyObjectSchema,
    id: {
      type: "string",
    },
    name: {
      type: "string",
    },
  },
  required: ["type", "last_edited_time", "id", "name"],
  additionalProperties: false,
};

export const DatabasePropertyConfigResponseSchema: JSONSchema = {
  anyOf: [
    NumberDatabasePropertyConfigResponseSchema,
    FormulaDatabasePropertyConfigResponseSchema,
    SelectDatabasePropertyConfigResponseSchema,
    MultiSelectDatabasePropertyConfigResponseSchema,
    StatusDatabasePropertyConfigResponseSchema,
    RelationDatabasePropertyConfigResponseSchema,
    RollupDatabasePropertyConfigResponseSchema,
    TitleDatabasePropertyConfigResponseSchema,
    RichTextDatabasePropertyConfigResponseSchema,
    UrlDatabasePropertyConfigResponseSchema,
    PeopleDatabasePropertyConfigResponseSchema,
    FilesDatabasePropertyConfigResponseSchema,
    EmailDatabasePropertyConfigResponseSchema,
    PhoneNumberDatabasePropertyConfigResponseSchema,
    DateDatabasePropertyConfigResponseSchema,
    CheckboxDatabasePropertyConfigResponseSchema,
    CreatedByDatabasePropertyConfigResponseSchema,
    CreatedTimeDatabasePropertyConfigResponseSchema,
    LastEditedByDatabasePropertyConfigResponseSchema,
    LastEditedTimeDatabasePropertyConfigResponseSchema,
  ],
};

export const DatabasePropertyConfigResponseRecordSchema: JSONSchema = {
  type: "object",
  additionalProperties: DatabasePropertyConfigResponseSchema,
};

export const PartialDatabaseObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    object: {
      type: "string",
      const: "database",
    },
    id: {
      type: "string",
    },
    properties: DatabasePropertyConfigResponseRecordSchema,
  },
  required: ["object", "id", "properties"],
  additionalProperties: false,
};

export const DatabaseObjectResponseSchema: JSONSchema = {
  type: "object",
  properties: {
    title: {
      type: "array",
      items: RichTextItemResponseSchema,
    },
    description: {
      type: "array",
      items: RichTextItemResponseSchema,
    },
    icon: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              const: "emoji",
            },
            emoji: EmojisSchema,
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
                url: TextRequestSchema,
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
                url: TextRequestSchema,
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
    properties: DatabasePropertyConfigResponseRecordSchema,
    parent: {
      anyOf: [
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
      ],
    },
    created_by: PartialUserObjectResponseSchema,
    last_edited_by: PartialUserObjectResponseSchema,
    is_inline: {
      type: "boolean",
    },
    object: {
      type: "string",
      const: "database",
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
    "title",
    "description",
    "icon",
    "cover",
    "properties",
    "parent",
    "created_by",
    "last_edited_by",
    "is_inline",
    "object",
    "id",
    "created_time",
    "last_edited_time",
    "archived",
    "url",
  ],
  additionalProperties: false,
};
