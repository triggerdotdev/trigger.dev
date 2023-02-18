import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import {
  makeArraySchema,
  makeNumberSchema,
  makeObjectSchema,
  makeStringSchema,
} from "core/schemas/makeSchema";
import {
  BaseIdParam,
  FieldSchema,
  RecordIdParam,
  TableIdOrNameParam,
  TimeZoneSchema,
} from "../common/schemas";

const errorResponse: EndpointSpecResponse = {
  success: false,
  name: "Error",
  description: "Error response",
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          error: {
            type: "string",
          },
        },
        required: ["error"],
      },
      {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              type: {
                type: "string",
              },
            },
            required: ["type"],
          },
        },
        required: ["error"],
      },
    ],
  },
};

export const listRecords: EndpointSpec = {
  path: "/{baseId}/{tableIdOrName}/listRecords",
  method: "POST",
  metadata: {
    name: "listRecords",
    description: `List records in a table. Note that table names and table ids can be used interchangeably. We recommend using table IDs so you don't need to modify your API request when your table name changes.\n
      The server returns one page of records at a time. Each page will contain pageSize records, which is 100 by default. If there are more records, the response will contain an offset. To fetch the next page of records, include offset in the next request's parameters. Pagination will stop when you've reached the end of your table. If the maxRecords parameter is passed, pagination will stop once you've reached this maximum.\n
      Returned records do not include any fields with "empty" values, e.g. "", [], or false.`,
    displayProperties: {
      title: "List records from table ${parameters.tableIdOrName}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://airtable.com/developers/web/api/get-record",
    },
    tags: ["records"],
  },
  security: {
    oauth: ["data.records:read"],
  },
  parameters: [BaseIdParam, TableIdOrNameParam],
  request: {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: {
      schema: makeObjectSchema("List records body", {
        optionalProperties: {
          timeZone: TimeZoneSchema,
          userLocal: makeStringSchema(
            "The user locale that should be used to format dates when using string as the cellFormat. This parameter is required when using string as the cellFormat."
          ),
          pageSize: makeNumberSchema(
            "The number of records returned in each request. Must be less than or equal to 100. Default is 100."
          ),
          maxRecords: makeNumberSchema(
            "The maximum total number of records that will be returned in your requests. If this value is larger than pageSize (which is 100 by default), you may have to load multiple pages to reach this total."
          ),
          offset: makeStringSchema(
            "To fetch the next page of records, include offset from the previous request in the next request's parameters."
          ),
          view: makeStringSchema(
            "The name or ID of a view in the table. If set, only the records in that view will be returned. The records will be sorted according to the order of the view unless the sort parameter is included, which overrides that order. Fields hidden in this view will be returned in the results. To only return a subset of fields, use the fields parameter."
          ),
          sort: makeArraySchema(
            "Sort",
            makeObjectSchema("Sort field", {
              requiredProperties: {
                field: makeStringSchema("Field name"),
              },
              optionalProperties: {
                direction: makeStringSchema("Direction", {
                  enum: ["asc", "desc"],
                }),
              },
            })
          ),
          filterByFormula: makeStringSchema(
            `A formula used to filter records. The formula will be evaluated for each record, and if the result is not 0, false, "", NaN, [], or #Error! the record will be included in the response. If combined with the view parameter, only records in that view which satisfy the formula will be returned. For example, to only include records where the column named "Category" equals "Programming", pass in: filterByFormula={Category}="Programming"`
          ),
          fields: makeArraySchema(
            "Only data for fields whose names or IDs are in this list will be included in the result. If you don't need every field, you can use this parameter to reduce the amount of data transferred.",
            makeStringSchema("Field name")
          ),
        },
      }),
    },
  },
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: makeObjectSchema("List records success body", {
          optionalProperties: {
            offset: makeStringSchema(
              "To fetch the next page of records, include offset from the previous request in the next request's parameters."
            ),
          },
          requiredProperties: {
            records: makeArraySchema(
              "Records",
              makeObjectSchema("Record", {
                requiredProperties: {
                  id: makeStringSchema("Record ID"),
                  createdTime: makeStringSchema(
                    `A date timestamp in the ISO format, eg:"2018-01-01T00:00:00.000Z"`
                  ),
                  fields: makeObjectSchema("Fields", {
                    additionalProperties: FieldSchema,
                  }),
                },
              })
            ),
          },
        }),
      },
    ],
    default: [errorResponse],
  },
};

export const getRecord: EndpointSpec = {
  path: "/{baseId}/{tableIdOrName}/{recordId}",
  method: "GET",
  metadata: {
    name: "getRecord",
    description:
      'Retrieve a single record. Any "empty" fields (e.g. "", [], or false) in the record will not be returned.',
    displayProperties: {
      title:
        "Get record ${parameters.recordId} from table ${parameters.tableIdOrName}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://airtable.com/developers/web/api/get-record",
    },
    tags: ["records"],
  },
  security: {
    oauth: ["data.records:read"],
  },
  parameters: [BaseIdParam, TableIdOrNameParam, RecordIdParam],
  request: {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  },
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: makeObjectSchema("Successful response", {
          requiredProperties: {
            createdTime: makeStringSchema("When the record was created"),
            fields: makeObjectSchema("Fields", {
              additionalProperties: FieldSchema,
            }),
            id: makeStringSchema("The record id"),
          },
        }),
      },
    ],
    default: [errorResponse],
  },
};
