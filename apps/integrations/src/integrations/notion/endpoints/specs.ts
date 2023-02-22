import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import {
  makeBooleanSchema,
  makeNullable,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { VersionHeaderParam } from "../common/schemas";

const errorResponse: EndpointSpecResponse = {
  success: false,
  name: "Error",
  description: "Error response",
  schema: {},
};

export const getUser: EndpointSpec = {
  path: "/users/{userId}",
  method: "GET",
  metadata: {
    name: "getUser",
    description: `List records in a table. Note that table names and table ids can be used interchangeably. We recommend using table IDs so you don't need to modify your API request when your table name changes.\n
      The server returns one page of records at a time. Each page will contain pageSize records, which is 100 by default. If there are more records, the response will contain an offset. To fetch the next page of records, include offset in the next request's parameters. Pagination will stop when you've reached the end of your table. If the maxRecords parameter is passed, pagination will stop once you've reached this maximum.\n
      Returned records do not include any fields with "empty" values, e.g. "", [], or false.`,
    displayProperties: {
      title: "List records from table ${parameters.tableIdOrName}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://airtable.com/developers/web/api/list-records",
    },
    tags: ["users"],
  },
  security: {
    oauth: [],
  },
  parameters: [
    {
      name: "userId",
      in: "path",
      description: "ID of the user you would like info about",
      schema: {
        type: "string",
      },
      required: true,
    },
    VersionHeaderParam,
  ],
  request: {},
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: makeOneOf("User", [
          makeObjectSchema("Person", {
            requiredProperties: {
              object: makeStringSchema("Object type", "This is always user", {
                enum: ["user"],
              }),
              id: makeStringSchema(
                "User ID",
                "Unique identifier for this user"
              ),
              type: makeStringSchema(
                "User type",
                "The user's type, either person or bot",
                {
                  enum: ["person"],
                }
              ),
              person: makeObjectSchema("Person", {
                requiredProperties: {
                  email: makeStringSchema("Email", "The user's email address"),
                },
              }),
            },
            optionalProperties: {
              name: makeStringSchema(
                "The user's full name",
                "The user's full name"
              ),
              avatar_url: makeNullable(
                makeStringSchema("Avatar URL", "The user's avatar URL")
              ),
            },
          }),
          makeObjectSchema("Bot", {
            requiredProperties: {
              object: makeStringSchema("Object type", "This is always user", {
                enum: ["user"],
              }),
              id: makeStringSchema(
                "User ID",
                "Unique identifier for this user"
              ),
              type: makeStringSchema(
                "User type",
                "The user's type, either person or bot",
                {
                  enum: ["bot"],
                }
              ),
              bot: makeObjectSchema("Bot", {
                requiredProperties: {
                  owner: makeObjectSchema("Owner", {
                    requiredProperties: {
                      type: makeStringSchema(
                        "Owner type",
                        "The owner's type, either user or workspace",
                        {
                          enum: ["user", "workspace"],
                        }
                      ),
                    },
                    optionalProperties: {
                      workspace: makeNullable(
                        makeBooleanSchema("Workspace", "Is this a workspace?")
                      ),
                    },
                  }),
                  workspace_name: makeNullable(
                    makeStringSchema(
                      "Workspace name",
                      "The name of the workspace"
                    )
                  ),
                },
              }),
            },
            optionalProperties: {
              name: makeStringSchema(
                "The user's full name",
                "The user's full name"
              ),
              avatar_url: makeNullable(
                makeStringSchema("Avatar URL", "The user's avatar URL")
              ),
            },
          }),
        ]),
      },
    ],
    default: [errorResponse],
  },
};
