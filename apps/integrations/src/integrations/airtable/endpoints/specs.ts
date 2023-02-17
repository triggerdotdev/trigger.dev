import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";

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
  path: "/{baseId}/{tableIdOrName}",
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
  parameters: [
    {
      name: "baseId",
      in: "path",
      description: "The ID of the base",
      schema: {
        type: "string",
      },
      required: true,
    },
    {
      name: "tableIdOrName",
      in: "path",
      description: "The name or id of the table",
      schema: {
        type: "string",
      },
      required: true,
    },
    {
      name: "recordId",
      in: "path",
      description: "The ID of the record",
      schema: {
        type: "string",
      },
      required: true,
    },
  ],
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
        schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "Generated schema for Root",
          type: "object",
          properties: {
            createdTime: {
              type: "string",
              description: "When the record was created",
            },
            fields: {
              type: "object",
              description: "All of the fields that are in this record",
              additionalProperties: true,
            },
            id: {
              description: "The record id",
              type: "string",
            },
          },
          required: ["createdTime", "fields", "id"],
        },
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
  parameters: [
    {
      name: "baseId",
      in: "path",
      description: "The ID of the base",
      schema: {
        type: "string",
      },
      required: true,
    },
    {
      name: "tableIdOrName",
      in: "path",
      description: "The name or id of the table",
      schema: {
        type: "string",
      },
      required: true,
    },
    {
      name: "recordId",
      in: "path",
      description: "The ID of the record",
      schema: {
        type: "string",
      },
      required: true,
    },
  ],
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
        schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "Generated schema for Root",
          type: "object",
          properties: {
            createdTime: {
              type: "string",
              description: "When the record was created",
            },
            fields: {
              type: "object",
              description: "All of the fields that are in this record",
              additionalProperties: true,
            },
            id: {
              description: "The record id",
              type: "string",
            },
          },
          required: ["createdTime", "fields", "id"],
        },
      },
    ],
    default: [errorResponse],
  },
};
