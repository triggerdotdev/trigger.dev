import { JSONSchema } from "core/schemas/types";
import { EmptyObject, IdRequest, SelectColor, StringRequest } from "./common";
import { RollupFunction } from "./functions";
import { SelectPropertyResponse } from "./responses";

export const NumberFormat: JSONSchema = {
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

export const NumberDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "number",
    },
    number: {
      type: "object",
      properties: {
        format: NumberFormat,
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

export const FormulaDatabasePropertyConfigResponse: JSONSchema = {
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

export const SelectDatabasePropertyConfigResponse: JSONSchema = {
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
          items: SelectPropertyResponse,
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

export const MultiSelectDatabasePropertyConfigResponse: JSONSchema = {
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
          items: SelectPropertyResponse,
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

export const StatusPropertyResponse: JSONSchema = {
  type: "object",
  properties: {
    id: StringRequest,
    name: StringRequest,
    color: SelectColor,
  },
  required: ["id", "name", "color"],
  additionalProperties: false,
};

export const StatusDatabasePropertyConfigResponse: JSONSchema = {
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
          items: StatusPropertyResponse,
        },
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: StringRequest,
              name: StringRequest,
              color: SelectColor,
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

export const SinglePropertyDatabasePropertyRelationConfigResponse: JSONSchema =
  {
    type: "object",
    properties: {
      type: {
        type: "string",
        const: "single_property",
      },
      single_property: EmptyObject,
      database_id: IdRequest,
    },
    required: ["type", "single_property", "database_id"],
    additionalProperties: false,
  };

export const DualPropertyDatabasePropertyRelationConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "dual_property",
    },
    dual_property: {
      type: "object",
      properties: {
        synced_property_id: StringRequest,
        synced_property_name: StringRequest,
      },
      required: ["synced_property_id", "synced_property_name"],
      additionalProperties: false,
    },
    database_id: IdRequest,
  },
  required: ["type", "dual_property", "database_id"],
  additionalProperties: false,
};

export const DatabasePropertyRelationConfigResponse: JSONSchema = {
  anyOf: [
    SinglePropertyDatabasePropertyRelationConfigResponse,
    DualPropertyDatabasePropertyRelationConfigResponse,
  ],
};

export const RelationDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "relation",
    },
    relation: DatabasePropertyRelationConfigResponse,
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

export const RollupDatabasePropertyConfigResponse: JSONSchema = {
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
        function: RollupFunction,
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

export const TitleDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "title",
    },
    title: EmptyObject,
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

export const RichTextDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "rich_text",
    },
    rich_text: EmptyObject,
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

export const UrlDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "url",
    },
    url: EmptyObject,
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

export const PeopleDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "people",
    },
    people: EmptyObject,
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

export const FilesDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "files",
    },
    files: EmptyObject,
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

export const EmailDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "email",
    },
    email: EmptyObject,
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

export const PhoneNumberDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "phone_number",
    },
    phone_number: EmptyObject,
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

export const DateDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "date",
    },
    date: EmptyObject,
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

export const CheckboxDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "checkbox",
    },
    checkbox: EmptyObject,
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

export const CreatedByDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "created_by",
    },
    created_by: EmptyObject,
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

export const CreatedTimeDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "created_time",
    },
    created_time: EmptyObject,
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

export const LastEditedByDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "last_edited_by",
    },
    last_edited_by: EmptyObject,
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

export const LastEditedTimeDatabasePropertyConfigResponse: JSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      const: "last_edited_time",
    },
    last_edited_time: EmptyObject,
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

export const DatabasePropertyConfigResponse: JSONSchema = {
  anyOf: [
    NumberDatabasePropertyConfigResponse,
    FormulaDatabasePropertyConfigResponse,
    SelectDatabasePropertyConfigResponse,
    MultiSelectDatabasePropertyConfigResponse,
    StatusDatabasePropertyConfigResponse,
    RelationDatabasePropertyConfigResponse,
    RollupDatabasePropertyConfigResponse,
    TitleDatabasePropertyConfigResponse,
    RichTextDatabasePropertyConfigResponse,
    UrlDatabasePropertyConfigResponse,
    PeopleDatabasePropertyConfigResponse,
    FilesDatabasePropertyConfigResponse,
    EmailDatabasePropertyConfigResponse,
    PhoneNumberDatabasePropertyConfigResponse,
    DateDatabasePropertyConfigResponse,
    CheckboxDatabasePropertyConfigResponse,
    CreatedByDatabasePropertyConfigResponse,
    CreatedTimeDatabasePropertyConfigResponse,
    LastEditedByDatabasePropertyConfigResponse,
    LastEditedTimeDatabasePropertyConfigResponse,
  ],
};
