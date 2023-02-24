import { JSONSchema } from "core/schemas/types";
import { TimeZoneSchema } from "./timezone";
import { EmojiRequest } from "./emojis";
import {
  makeArraySchema,
  makeBooleanSchema,
  makeNull,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import {
  PartialUserObjectResponse,
  PersonUserObjectResponse,
  UserObjectResponse,
} from "./person";
import { DateResponse, FormulaPropertyResponse } from "./formula";
import { RichTextItemResponse, TextRequest } from "./richText";

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
const URLSchema = makeObjectSchema("Page property URL", {
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

// | {
//     type: "created_by"
//     created_by: PartialUserObjectResponse | UserObjectResponse
//     id: string
//   }
const CreatedBySchema = makeObjectSchema("Page property created by", {
  requiredProperties: {
    type: makePropertyTypeSchema("created_by"),
    id: IDSchema,
    created_by: makeOneOf("Created by", [
      PartialUserObjectResponse,
      PersonUserObjectResponse,
    ]),
  },
});

// | { type: "created_time"; created_time: string; id: string }
const CreatedTimeSchema = makeObjectSchema("Page property created time", {
  requiredProperties: {
    type: makePropertyTypeSchema("created_time"),
    id: IDSchema,
    created_time: makeStringSchema("Created time", "The created time"),
  },
});

// | {
//     type: "last_edited_by"
//     last_edited_by: PartialUserObjectResponse | UserObjectResponse
//     id: string
//   }
const LastEditedBySchema = makeObjectSchema("Page property last edited by", {
  requiredProperties: {
    type: makePropertyTypeSchema("last_edited_by"),
    id: IDSchema,
    last_edited_by: makeOneOf("Last edited by", [
      PartialUserObjectResponse,
      PersonUserObjectResponse,
    ]),
  },
});

// | { type: "last_edited_time"; last_edited_time: string; id: string }
const LastEditedTimeSchema = makeObjectSchema(
  "Page property last edited time",
  {
    requiredProperties: {
      type: makePropertyTypeSchema("last_edited_time"),
      id: IDSchema,
      last_edited_time: makeStringSchema(
        "Last edited time",
        "The last edited time"
      ),
    },
  }
);

// | { type: "formula"; formula: FormulaPropertyResponse; id: string }
const FormulaSchema = makeObjectSchema("Page property formula", {
  requiredProperties: {
    type: makePropertyTypeSchema("formula"),
    id: IDSchema,
    formula: FormulaPropertyResponse,
  },
});

// | { type: "title"; title: Array<RichTextItemResponse>; id: string }
const TitleSchema = makeObjectSchema("Page property title", {
  requiredProperties: {
    type: makePropertyTypeSchema("title"),
    id: IDSchema,
    title: makeArraySchema("Title", RichTextItemResponse),
  },
});

// | { type: "rich_text"; rich_text: Array<RichTextItemResponse>; id: string }
const RichTextSchema = makeObjectSchema("Page property rich text", {
  requiredProperties: {
    type: makePropertyTypeSchema("rich_text"),
    id: IDSchema,
    rich_text: makeArraySchema("Rich text", RichTextItemResponse),
  },
});

// | {
//     type: "people"
//     people: Array<PartialUserObjectResponse | UserObjectResponse>
//     id: string
//   }
const PeopleSchema = makeObjectSchema("Page property people", {
  requiredProperties: {
    type: makePropertyTypeSchema("people"),
    id: IDSchema,
    people: makeArraySchema("People", [
      PartialUserObjectResponse,
      UserObjectResponse,
    ]),
  },
});

// | { type: "relation"; relation: Array<{ id: string }>; id: string }
const RelationSchema = makeObjectSchema("Page property relation", {
  requiredProperties: {
    type: makePropertyTypeSchema("relation"),
    id: IDSchema,
    relation: makeArraySchema(
      "Relation",
      makeObjectSchema("Relation", {
        requiredProperties: {
          id: makeStringSchema("ID", "The ID of the relation"),
        },
      })
    ),
  },
});

// type RollupFunction =
//   | "count"
//   | "count_values"
//   | "empty"
//   | "not_empty"
//   | "unique"
//   | "show_unique"
//   | "percent_empty"
//   | "percent_not_empty"
//   | "sum"
//   | "average"
//   | "median"
//   | "min"
//   | "max"
//   | "range"
//   | "earliest_date"
//   | "latest_date"
//   | "date_range"
//   | "checked"
//   | "unchecked"
//   | "percent_checked"
//   | "percent_unchecked"
//   | "count_per_group"
//   | "percent_per_group"
//   | "show_original"
const RollupFunction = makeStringSchema(
  "Rollup function",
  "The function of the rollup",
  {
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
  }
);

// { type: "number"; number: number | null; function: RollupFunction }
const RollupNumberSchema = makeObjectSchema("Rollup number", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of the rollup", {
      const: "number",
    }),
    number: makeNullable(
      makeNumberSchema("Number", "The number of the rollup")
    ),
    function: RollupFunction,
  },
});

//{
//   type: "date"
//   date: DateResponse | null
//   function: RollupFunction
// }
const RollupDateSchema = makeObjectSchema("Rollup date", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of the rollup", {
      const: "date",
    }),
    date: makeNullable(DateResponse),
    function: RollupFunction,
  },
});

// {
//   type: "array"
//   array: Array<
//     | { type: "title"; title: Array<RichTextItemResponse> }
//     | { type: "rich_text"; rich_text: Array<RichTextItemResponse> }
//     | {
//         type: "people"
//         people: Array<
//           PartialUserObjectResponse | UserObjectResponse
//         >
//       }
//     | { type: "relation"; relation: Array<{ id: string }> }
//   >
//   function: RollupFunction
// }
const RollupArraySchema = makeObjectSchema("Rollup array", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of the rollup", {
      const: "array",
    }),
    function: RollupFunction,
    array: makeArraySchema(
      "Array",
      makeOneOf("Array item", [
        makeObjectSchema("Array item title", {
          requiredProperties: {
            type: makeStringSchema("Type", "The type of the array item", {
              const: "title",
            }),
            title: makeArraySchema("Title", RichTextItemResponse),
          },
        }),
        makeObjectSchema("Array item rich text", {
          requiredProperties: {
            type: makeStringSchema("Type", "The type of the array item", {
              const: "rich_text",
            }),
            rich_text: makeArraySchema("Rich text", RichTextItemResponse),
          },
        }),
        makeObjectSchema("Array item people", {
          requiredProperties: {
            type: makeStringSchema("Type", "The type of the array item", {
              const: "people",
            }),
            people: makeArraySchema(
              "People",
              makeOneOf("People", [
                PartialUserObjectResponse,
                UserObjectResponse,
              ])
            ),
          },
        }),
        makeObjectSchema("Array item relation", {
          requiredProperties: {
            type: makeStringSchema("Type", "The type of the array item", {
              const: "relation",
            }),
            relation: makeArraySchema(
              "Relation",
              makeObjectSchema("Relation", {
                requiredProperties: {
                  id: makeStringSchema("ID", "The ID of the relation"),
                },
              })
            ),
          },
        }),
      ])
    ),
  },
});

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
export const RollupSchema = makeObjectSchema("Page property rollup", {
  requiredProperties: {
    type: makePropertyTypeSchema("rollup"),
    id: IDSchema,
    rollup: makeOneOf("Rollup", [
      RollupNumberSchema,
      RollupDateSchema,
      RollupArraySchema,
    ]),
  },
});

// export type PartialPageObjectResponse = { object: "page"; id: string }
export const PartialPageObjectResponse = makeObjectSchema(
  "Partial page object",
  {
    requiredProperties: {
      object: makeStringSchema("Object", "The object type", {
        const: "page",
      }),
      id: IDSchema,
    },
  }
);

// export type PageObjectResponse = {
//   parent:
//     | { type: "database_id"; database_id: string }
//     | { type: "page_id"; page_id: string }
//     | { type: "block_id"; block_id: string }
//     | { type: "workspace"; workspace: true }
//   properties: Record<
//     string,
//     | { type: "number"; number: number | null; id: string }
//     | { type: "url"; url: string | null; id: string }
//     | { type: "select"; select: SelectPropertyResponse | null; id: string }
//     | {
//         type: "multi_select"
//         multi_select: Array<SelectPropertyResponse>
//         id: string
//       }
//     | { type: "status"; status: SelectPropertyResponse | null; id: string }
//     | { type: "date"; date: DateResponse | null; id: string }
//     | { type: "email"; email: string | null; id: string }
//     | { type: "phone_number"; phone_number: string | null; id: string }
//     | { type: "checkbox"; checkbox: boolean; id: string }
//     | {
//         type: "files"
//         files: Array<
//           | {
//               file: { url: string; expiry_time: string }
//               name: StringRequest
//               type?: "file"
//             }
//           | {
//               external: { url: TextRequest }
//               name: StringRequest
//               type?: "external"
//             }
//         >
//         id: string
//       }
//     | {
//         type: "created_by"
//         created_by: PartialUserObjectResponse | UserObjectResponse
//         id: string
//       }
//     | { type: "created_time"; created_time: string; id: string }
//     | {
//         type: "last_edited_by"
//         last_edited_by: PartialUserObjectResponse | UserObjectResponse
//         id: string
//       }
//     | { type: "last_edited_time"; last_edited_time: string; id: string }
//     | { type: "formula"; formula: FormulaPropertyResponse; id: string }
//     | { type: "title"; title: Array<RichTextItemResponse>; id: string }
//     | { type: "rich_text"; rich_text: Array<RichTextItemResponse>; id: string }
//     | {
//         type: "people"
//         people: Array<PartialUserObjectResponse | UserObjectResponse>
//         id: string
//       }
//     | { type: "relation"; relation: Array<{ id: string }>; id: string }
//     | {
//         type: "rollup"
//         rollup:
//           | { type: "number"; number: number | null; function: RollupFunction }
//           | {
//               type: "date"
//               date: DateResponse | null
//               function: RollupFunction
//             }
//           | {
//               type: "array"
//               array: Array<
//                 | { type: "title"; title: Array<RichTextItemResponse> }
//                 | { type: "rich_text"; rich_text: Array<RichTextItemResponse> }
//                 | {
//                     type: "people"
//                     people: Array<
//                       PartialUserObjectResponse | UserObjectResponse
//                     >
//                   }
//                 | { type: "relation"; relation: Array<{ id: string }> }
//               >
//               function: RollupFunction
//             }
//         id: string
//       }
//   >
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
//   created_by: PartialUserObjectResponse
//   last_edited_by: PartialUserObjectResponse
//   object: "page"
//   id: string
//   created_time: string
//   last_edited_time: string
//   archived: boolean
//   url: string
// }
const AllPageProperties = makeOneOf("Page property", [
  NumberSchema,
  URLSchema,
  SelectSchema,
  MultiSelectSchema,
  StatusSchema,
  DateSchema,
  EmailSchema,
  PhoneNumberSchema,
  CheckboxSchema,
  FilesSchema,
  CreatedBySchema,
  CreatedTimeSchema,
  LastEditedBySchema,
  LastEditedTimeSchema,
  FormulaSchema,
  TitleSchema,
  RichTextSchema,
  PeopleSchema,
  RelationSchema,
  RollupSchema,
]);

// { type: "emoji"; emoji: EmojiRequest }
const IconEmojiSchema = makeObjectSchema("Icon emoji", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of icon", {
      const: "emoji",
    }),
    emoji: EmojiRequest,
  },
});

// { type: "external"; external: { url: TextRequest } }
const ExternalFileReferenceSchema = makeObjectSchema("Icon external", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of icon", {
      const: "external",
    }),
    external: makeObjectSchema("External", {
      requiredProperties: {
        url: TextRequest,
      },
    }),
  },
});

// { type: "file"; file: { url: string; expiry_time: string } }
const FileRefenceSchema = makeObjectSchema("Icon file", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of icon", {
      const: "file",
    }),
    file: makeObjectSchema("File", {
      requiredProperties: {
        url: makeStringSchema("URL", "The URL of the file"),
        expiry_time: makeStringSchema(
          "Expiry time",
          "The time the file will expire"
        ),
      },
    }),
  },
});

export const IconSchema = makeOneOf("Icon", [
  IconEmojiSchema,
  ExternalFileReferenceSchema,
  FileRefenceSchema,
  makeNull(),
]);

export const CoverSchema = makeOneOf("Cover", [
  ExternalFileReferenceSchema,
  FileRefenceSchema,
  makeNull(),
]);

export const PageObjectResponse = makeObjectSchema("Page object", {
  requiredProperties: {
    object: makeStringSchema("Object", "The object type", {
      const: "page",
    }),
    id: IDSchema,
    created_time: makeStringSchema(
      "Created time",
      "The time the page was created"
    ),
    last_edited_time: makeStringSchema(
      "Last edited time",
      "The time the page was last edited"
    ),
    archived: makeBooleanSchema("Archived", "Whether the page is archived"),
    url: makeStringSchema("URL", "The URL of the page"),
    parent: PageParentSchema,
    properties: makeObjectSchema("Properties", {
      additionalProperties: AllPageProperties,
    }),
    created_by: PartialUserObjectResponse,
    last_edited_by: PartialUserObjectResponse,
    icon: IconSchema,
    cover: CoverSchema,
  },
  optionalProperties: {},
});

export const GetPageResponse = makeOneOf("Get page response", [
  PageObjectResponse,
  PartialPageObjectResponse,
]);
