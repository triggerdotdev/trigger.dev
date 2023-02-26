import {
  makeAnyOf,
  makeArraySchema,
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeRecordSchema,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { Parent } from "json-schema-to-typescript/dist/src/types/JSONSchema";
import { EmptyObject, IdRequest, StringRequest } from "./common";
import {
  CoverSchema,
  IconSchema,
  ParentBlockSchema,
  ParentPageIdSchema,
  ParentWorkspaceSchema,
  RollupFunction,
  SelectColor,
  SelectPropertyResponse,
} from "./page";
import { PartialUserObjectResponse } from "./person";
import { RichTextItemResponse } from "./richText";

function makePropertyTypeSchema(constant: string): JSONSchema {
  return makeStringSchema("Type", "The type of the property", {
    const: constant,
  });
}

// type NumberFormat =
//   | "number"
//   | "number_with_commas"
//   | "percent"
//   | "dollar"
//   | "canadian_dollar"
//   | "singapore_dollar"
//   | "euro"
//   | "pound"
//   | "yen"
//   | "ruble"
//   | "rupee"
//   | "won"
//   | "yuan"
//   | "real"
//   | "lira"
//   | "rupiah"
//   | "franc"
//   | "hong_kong_dollar"
//   | "new_zealand_dollar"
//   | "krona"
//   | "norwegian_krone"
//   | "mexican_peso"
//   | "rand"
//   | "new_taiwan_dollar"
//   | "danish_krone"
//   | "zloty"
//   | "baht"
//   | "forint"
//   | "koruna"
//   | "shekel"
//   | "chilean_peso"
//   | "philippine_peso"
//   | "dirham"
//   | "colombian_peso"
//   | "riyal"
//   | "ringgit"
//   | "leu"
//   | "argentine_peso"
//   | "uruguayan_peso";
export const NumberFormat = makeStringSchema(
  "NumberFormat",
  "The format of a number",
  {
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
  }
);

// type NumberDatabasePropertyConfigResponse = {
//   type: "number";
//   number: { format: NumberFormat };
//   id: string;
//   name: string;
// };
export const NumberDatabasePropertyConfigResponse = makeObjectSchema(
  "NumberDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("number"),
      number: makeObjectSchema("number", {
        requiredProperties: { format: NumberFormat },
      }),
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type FormulaDatabasePropertyConfigResponse = {
//   type: "formula";
//   formula: { expression: string };
//   id: string;
//   name: string;
// };
export const FormulaDatabasePropertyConfigResponse = makeObjectSchema(
  "FormulaDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("formula"),
      formula: makeObjectSchema("formula", {
        requiredProperties: { expression: makeStringSchema("expression") },
      }),
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type SelectDatabasePropertyConfigResponse = {
//   type: "select";
//   select: { options: Array<SelectPropertyResponse> };
//   id: string;
//   name: string;
// };
export const SelectDatabasePropertyConfigResponse = makeObjectSchema(
  "SelectDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("select"),
      select: makeObjectSchema("select", {
        requiredProperties: {
          options: makeArraySchema("options", SelectPropertyResponse),
        },
      }),
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type MultiSelectDatabasePropertyConfigResponse = {
//   type: "multi_select";
//   multi_select: { options: Array<SelectPropertyResponse> };
//   id: string;
//   name: string;
// };
export const MultiSelectDatabasePropertyConfigResponse = makeObjectSchema(
  "MultiSelectDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("multi_select"),
      multi_select: makeObjectSchema("multi_select", {
        requiredProperties: {
          options: makeArraySchema("options", SelectPropertyResponse),
        },
      }),
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type StatusPropertyResponse = {
//   id: StringRequest;
//   name: StringRequest;
//   color: SelectColor;
// };
export const StatusPropertyResponse = makeObjectSchema(
  "StatusPropertyResponse",
  {
    requiredProperties: {
      id: StringRequest,
      name: StringRequest,
      color: SelectColor,
    },
  }
);

// type StatusDatabasePropertyConfigResponse = {
//   type: "status";
//   status: {
//     options: Array<StatusPropertyResponse>;
//     groups: Array<{
//       id: StringRequest;
//       name: StringRequest;
//       color: SelectColor;
//       option_ids: Array<string>;
//     }>;
//   };
//   id: string;
//   name: string;
// };
export const StatusDatabasePropertyConfigResponse = makeObjectSchema(
  "StatusDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("status"),
      status: makeObjectSchema("status", {
        requiredProperties: {
          options: makeArraySchema("options", StatusPropertyResponse),
          groups: makeArraySchema("groups", {
            requiredProperties: {
              id: StringRequest,
              name: StringRequest,
              color: SelectColor,
              option_ids: makeArraySchema(
                "option_ids",
                makeStringSchema("Option id")
              ),
            },
          }),
        },
      }),
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type SinglePropertyDatabasePropertyRelationConfigResponse = {
//   type: "single_property";
//   single_property: EmptyObject;
//   database_id: IdRequest;
// };
export const SinglePropertyDatabasePropertyRelationConfigResponse =
  makeObjectSchema("SinglePropertyDatabasePropertyRelationConfigResponse", {
    requiredProperties: {
      type: makePropertyTypeSchema("single_property"),
      single_property: EmptyObject,
      database_id: IdRequest,
    },
  });

// type DualPropertyDatabasePropertyRelationConfigResponse = {
//   type: "dual_property";
//   dual_property: {
//     synced_property_id: StringRequest;
//     synced_property_name: StringRequest;
//   };
//   database_id: IdRequest;
// };
export const DualPropertyDatabasePropertyRelationConfigResponse =
  makeObjectSchema("DualPropertyDatabasePropertyRelationConfigResponse", {
    requiredProperties: {
      type: makePropertyTypeSchema("dual_property"),
      dual_property: makeObjectSchema("dual_property", {
        requiredProperties: {
          synced_property_id: StringRequest,
          synced_property_name: StringRequest,
        },
      }),
      database_id: IdRequest,
    },
  });

// type DatabasePropertyRelationConfigResponse =
//   | SinglePropertyDatabasePropertyRelationConfigResponse
//   | DualPropertyDatabasePropertyRelationConfigResponse;
export const DatabasePropertyRelationConfigResponse = makeOneOf(
  "DatabasePropertyRelationConfigResponse",
  [
    SinglePropertyDatabasePropertyRelationConfigResponse,
    DualPropertyDatabasePropertyRelationConfigResponse,
  ]
);

// type RelationDatabasePropertyConfigResponse = {
//   type: "relation";
//   relation: DatabasePropertyRelationConfigResponse;
//   id: string;
//   name: string;
// };
export const RelationDatabasePropertyConfigResponse = makeObjectSchema(
  "RelationDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("relation"),
      relation: DatabasePropertyRelationConfigResponse,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type RollupDatabasePropertyConfigResponse = {
//   type: "rollup";
//   rollup: {
//     rollup_property_name: string;
//     relation_property_name: string;
//     rollup_property_id: string;
//     relation_property_id: string;
//     function: RollupFunction;
//   };
//   id: string;
//   name: string;
// };
export const RollupDatabasePropertyConfigResponse = makeObjectSchema(
  "RollupDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("rollup"),
      rollup: makeObjectSchema("rollup", {
        requiredProperties: {
          rollup_property_name: makeStringSchema(
            "rollup_property_name",
            "The name of the rollup property"
          ),
          relation_property_name: makeStringSchema(
            "relation_property_name",
            "The name of the relation property"
          ),
          rollup_property_id: makeStringSchema(
            "rollup_property_id",
            "The id of the rollup property"
          ),
          relation_property_id: makeStringSchema(
            "relation_property_id",
            "The id of the relation property"
          ),
          function: RollupFunction,
        },
      }),
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type TitleDatabasePropertyConfigResponse = {
//   type: "title";
//   title: EmptyObject;
//   id: string;
//   name: string;
// };
export const TitleDatabasePropertyConfigResponse = makeObjectSchema(
  "TitleDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("title"),
      title: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type RichTextDatabasePropertyConfigResponse = {
//   type: "rich_text";
//   rich_text: EmptyObject;
//   id: string;
//   name: string;
// };
export const RichTextDatabasePropertyConfigResponse = makeObjectSchema(
  "RichTextDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("rich_text"),
      rich_text: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type UrlDatabasePropertyConfigResponse = {
//   type: "url";
//   url: EmptyObject;
//   id: string;
//   name: string;
// };
export const UrlDatabasePropertyConfigResponse = makeObjectSchema(
  "UrlDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("url"),
      url: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type PeopleDatabasePropertyConfigResponse = {
//   type: "people";
//   people: EmptyObject;
//   id: string;
//   name: string;
// };
export const PeopleDatabasePropertyConfigResponse = makeObjectSchema(
  "PeopleDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("people"),
      people: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type FilesDatabasePropertyConfigResponse = {
//   type: "files";
//   files: EmptyObject;
//   id: string;
//   name: string;
// };
export const FilesDatabasePropertyConfigResponse = makeObjectSchema(
  "FilesDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("files"),
      files: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type EmailDatabasePropertyConfigResponse = {
//   type: "email";
//   email: EmptyObject;
//   id: string;
//   name: string;
// };
export const EmailDatabasePropertyConfigResponse = makeObjectSchema(
  "EmailDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("email"),
      email: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type PhoneNumberDatabasePropertyConfigResponse = {
//   type: "phone_number";
//   phone_number: EmptyObject;
//   id: string;
//   name: string;
// };
export const PhoneNumberDatabasePropertyConfigResponse = makeObjectSchema(
  "PhoneNumberDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("phone_number"),
      phone_number: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type DateDatabasePropertyConfigResponse = {
//   type: "date";
//   date: EmptyObject;
//   id: string;
//   name: string;
// };
export const DateDatabasePropertyConfigResponse = makeObjectSchema(
  "DateDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("date"),
      date: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type CheckboxDatabasePropertyConfigResponse = {
//   type: "checkbox";
//   checkbox: EmptyObject;
//   id: string;
//   name: string;
// };
export const CheckboxDatabasePropertyConfigResponse = makeObjectSchema(
  "CheckboxDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("checkbox"),
      checkbox: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type CreatedByDatabasePropertyConfigResponse = {
//   type: "created_by";
//   created_by: EmptyObject;
//   id: string;
//   name: string;
// };
export const CreatedByDatabasePropertyConfigResponse = makeObjectSchema(
  "CreatedByDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("created_by"),
      created_by: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type CreatedTimeDatabasePropertyConfigResponse = {
//   type: "created_time";
//   created_time: EmptyObject;
//   id: string;
//   name: string;
// };
export const CreatedTimeDatabasePropertyConfigResponse = makeObjectSchema(
  "CreatedTimeDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("created_time"),
      created_time: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type LastEditedByDatabasePropertyConfigResponse = {
//   type: "last_edited_by";
//   last_edited_by: EmptyObject;
//   id: string;
//   name: string;
// };
export const LastEditedByDatabasePropertyConfigResponse = makeObjectSchema(
  "LastEditedByDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("last_edited_by"),
      last_edited_by: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type LastEditedTimeDatabasePropertyConfigResponse = {
//   type: "last_edited_time";
//   last_edited_time: EmptyObject;
//   id: string;
//   name: string;
// };
export const LastEditedTimeDatabasePropertyConfigResponse = makeObjectSchema(
  "LastEditedTimeDatabasePropertyConfigResponse",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("last_edited_time"),
      last_edited_time: EmptyObject,
      id: makeStringSchema("id", "The id of the property"),
      name: makeStringSchema("name", "The name of the property"),
    },
  }
);

// type DatabasePropertyConfigResponse =
//   | NumberDatabasePropertyConfigResponse
//   | FormulaDatabasePropertyConfigResponse
//   | SelectDatabasePropertyConfigResponse
//   | MultiSelectDatabasePropertyConfigResponse
//   | StatusDatabasePropertyConfigResponse
//   | RelationDatabasePropertyConfigResponse
//   | RollupDatabasePropertyConfigResponse
//   | TitleDatabasePropertyConfigResponse
//   | RichTextDatabasePropertyConfigResponse
//   | UrlDatabasePropertyConfigResponse
//   | PeopleDatabasePropertyConfigResponse
//   | FilesDatabasePropertyConfigResponse
//   | EmailDatabasePropertyConfigResponse
//   | PhoneNumberDatabasePropertyConfigResponse
//   | DateDatabasePropertyConfigResponse
//   | CheckboxDatabasePropertyConfigResponse
//   | CreatedByDatabasePropertyConfigResponse
//   | CreatedTimeDatabasePropertyConfigResponse
//   | LastEditedByDatabasePropertyConfigResponse
//   | LastEditedTimeDatabasePropertyConfigResponse;
export const DatabasePropertyConfigResponse = makeOneOf(
  "DatabasePropertyConfigResponse",
  [
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
  ]
);

// export type PartialDatabaseObjectResponse = {
//   object: "database";
//   id: string;
//   properties: Record<string, DatabasePropertyConfigResponse>;
// };
export const PartialDatabaseObjectResponse = makeObjectSchema(
  "PartialDatabaseObjectResponse",
  {
    requiredProperties: {
      object: makeStringSchema("object", "The object type", {
        const: "database",
      }),
      id: makeStringSchema("id", "The id of the database"),
      properties: makeRecordSchema(
        "properties",
        DatabasePropertyConfigResponse
      ),
    },
  }
);

export const DatabaseParentSchema = makeOneOf("Database parent", [
  ParentPageIdSchema,
  ParentBlockSchema,
  ParentWorkspaceSchema,
]);

// export type DatabaseObjectResponse = {
//   title: Array<RichTextItemResponse>
//   description: Array<RichTextItemResponse>
//   icon:
//     | { type: "emoji"; emoji: EmojiRequest }
//     | null
//     | { type: "external"; external: { url: TextRequest } }
//     | null
//     | { type: "file"; file: { url: string; expiry_time: string } }
//     | null
//   cover:
//     | { type: "external"; external: { url: TextRequest } }
//     | null
//     | { type: "file"; file: { url: string; expiry_time: string } }
//     | null
//   properties: Record<string, DatabasePropertyConfigResponse>
//   parent:
//     | { type: "page_id"; page_id: string }
//     | { type: "workspace"; workspace: true }
//     | { type: "block_id"; block_id: string }
//   created_by: PartialUserObjectResponse
//   last_edited_by: PartialUserObjectResponse
//   is_inline: boolean
//   object: "database"
//   id: string
//   created_time: string
//   last_edited_time: string
//   archived: boolean
//   url: string
// }
export const DatabaseObjectResponse = makeObjectSchema(
  "DatabaseObjectResponse",
  {
    requiredProperties: {
      title: makeArraySchema("title", RichTextItemResponse),
      description: makeArraySchema("description", RichTextItemResponse),
      icon: IconSchema,
      cover: CoverSchema,
      properties: makeRecordSchema(
        "properties",
        DatabasePropertyConfigResponse
      ),
      parent: DatabaseParentSchema,
      created_by: PartialUserObjectResponse,
      last_edited_by: PartialUserObjectResponse,
      is_inline: makeBooleanSchema(
        "is_inline",
        "Whether the database is inline"
      ),
      object: makeStringSchema("object", "The object type", {
        const: "database",
      }),
      id: makeStringSchema("id", "The id of the database"),
      created_time: makeStringSchema(
        "created_time",
        "The time the database was created"
      ),
      last_edited_time: makeStringSchema(
        "last_edited_time",
        "The time the database was last edited"
      ),
      archived: makeBooleanSchema(
        "archived",
        "Whether the database is archived"
      ),
      url: makeStringSchema("url", "The url of the database"),
    },
  }
);

// { title: Array<RichTextItemRequest>; type?: "title" }
const TitleDatabasePropertySchema = makeObjectSchema(
  "TitleDatabasePropertySchema",
  {
    requiredProperties: {
      title: makeArraySchema("title", RichTextItemRequest),
    },
    optionalProperties: {
      type: makeStringSchema("type", "The type of the property", {
        const: "title",
      }),
    },
  }
);

// Record<
//   string,
//   | { title: Array<RichTextItemRequest>; type?: "title" }
//   | { rich_text: Array<RichTextItemRequest>; type?: "rich_text" }
//   | { number: number | null; type?: "number" }
//   | { url: TextRequest | null; type?: "url" }
//   | {
//       select:
//         | {
//             id: StringRequest
//             name?: StringRequest
//             color?: SelectColor
//           }
//         | null
//         | {
//             name: StringRequest
//             id?: StringRequest
//             color?: SelectColor
//           }
//         | null
//       type?: "select"
//     }
//   | {
//       multi_select: Array<
//         | {
//             id: StringRequest
//             name?: StringRequest
//             color?: SelectColor
//           }
//         | {
//             name: StringRequest
//             id?: StringRequest
//             color?: SelectColor
//           }
//       >
//       type?: "multi_select"
//     }
//   | {
//       people: Array<
//         | { id: IdRequest }
//         | {
//             person: { email?: string }
//             id: IdRequest
//             type?: "person"
//             name?: string | null
//             avatar_url?: string | null
//             object?: "user"
//           }
//         | {
//             bot:
//               | EmptyObject
//               | {
//                   owner:
//                     | {
//                         type: "user"
//                         user:
//                           | {
//                               type: "person"
//                               person: { email: string }
//                               name: string | null
//                               avatar_url: string | null
//                               id: IdRequest
//                               object: "user"
//                             }
//                           | PartialUserObjectResponse
//                       }
//                     | { type: "workspace"; workspace: true }
//                   workspace_name: string | null
//                 }
//             id: IdRequest
//             type?: "bot"
//             name?: string | null
//             avatar_url?: string | null
//             object?: "user"
//           }
//       >
//       type?: "people"
//     }
//   | { email: StringRequest | null; type?: "email" }
//   | { phone_number: StringRequest | null; type?: "phone_number" }
//   | { date: DateRequest | null; type?: "date" }
//   | { checkbox: boolean; type?: "checkbox" }
//   | { relation: Array<{ id: IdRequest }>; type?: "relation" }
//   | {
//       files: Array<
//         | {
//             file: { url: string; expiry_time?: string }
//             name: StringRequest
//             type?: "file"
//           }
//         | {
//             external: { url: TextRequest }
//             name: StringRequest
//             type?: "external"
//           }
//       >
//       type?: "files"
//     }
//   | {
//       status:
//         | {
//             id: StringRequest
//             name?: StringRequest
//             color?: SelectColor
//           }
//         | null
//         | {
//             name: StringRequest
//             id?: StringRequest
//             color?: SelectColor
//           }
//         | null
//       type?: "status"
//     }
// >

const CreateDatabaseProperties1 = makeRecordSchema(
  "Create database properties",
  makeOneOf("Create database property", [])
);
