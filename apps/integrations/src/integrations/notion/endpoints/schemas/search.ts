import {
  makeArraySchema,
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { EmptyObject } from "./common";
import { PageObjectResponse, PartialPageObjectResponse } from "./page";

// type SearchBodyParameters = {
//   sort?: {
//     timestamp: "last_edited_time"
//     direction: "ascending" | "descending"
//   }
//   query?: string
//   start_cursor?: string
//   page_size?: number
//   filter?: { property: "object"; value: "page" | "database" }
// }
export const SearchBodyParameters = makeObjectSchema("SearchBodyParameters", {
  optionalProperties: {
    sort: makeObjectSchema("Sort", {
      requiredProperties: {
        timestamp: makeStringSchema("Timestamp", "The timestamp to sort by", {
          const: "last_edited_time",
        }),
        direction: makeStringSchema("Direction", "The direction to sort by", {
          enum: ["ascending", "descending"],
        }),
      },
    }),
    query: makeStringSchema("Query", "The query to search for"),
    start_cursor: makeStringSchema("Start cursor", "The cursor to start at"),
    page_size: makeNumberSchema("Page size", "The number of results to return"),
    filter: makeObjectSchema("Filter", {
      requiredProperties: {
        property: makeStringSchema("Property", "The property to filter by", {
          const: "object",
        }),
        value: makeStringSchema("Value", "The value to filter by", {
          enum: ["page", "database"],
        }),
      },
    }),
  },
});

// export type SearchResponse = {
//   type: "page_or_database"
//   page_or_database: EmptyObject
//   object: "list"
//   next_cursor: string | null
//   has_more: boolean
//   results: Array<
//     | PageObjectResponse
//     | PartialPageObjectResponse
//     | PartialDatabaseObjectResponse
//     | DatabaseObjectResponse
//   >
// }
export const SearchResponse = makeObjectSchema("SearchResponse", {
  requiredProperties: {
    type: makeStringSchema("Type", "The type of the response", {
      const: "page_or_database",
    }),
    page_or_database: EmptyObject,
    object: makeStringSchema("Object", "The object type", {
      const: "list",
    }),
    next_cursor: makeNullable(
      makeStringSchema("Next cursor", "The next cursor")
    ),
    has_more: makeBooleanSchema("Has more", "Whether there are more results"),
    results: makeArraySchema(
      "Results",
      makeOneOf("Result", [
        PageObjectResponse,
        PartialPageObjectResponse,
        //todo PartialDatabaseObjectResponse,
        //todo DatabaseObjectResponse,
      ])
    ),
  },
});
