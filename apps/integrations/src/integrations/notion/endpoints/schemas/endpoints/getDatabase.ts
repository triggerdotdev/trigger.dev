import { JSONSchema } from "core/schemas/types";
import { IdRequest } from "../common";
import {
  DatabaseObjectResponse,
  PartialDatabaseObjectResponse,
} from "../database";

export const GetDatabasePathParameters: JSONSchema = {
  type: "object",
  properties: {
    database_id: IdRequest,
  },
  required: ["database_id"],
  additionalProperties: false,
};

export const GetDatabaseParameters: JSONSchema = GetDatabasePathParameters;

export const GetDatabaseResponse: JSONSchema = {
  anyOf: [PartialDatabaseObjectResponse, DatabaseObjectResponse],
};
