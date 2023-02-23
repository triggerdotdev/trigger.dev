import { JSONSchema } from "core/schemas/types";
import {
  PartialDatabaseObjectResponseSchema,
  DatabaseObjectResponseSchema,
} from "./database";
import { IdRequestSchema } from "./primitives";

export const GetDatabasePathParametersSchema: JSONSchema = {
  type: "object",
  properties: {
    database_id: IdRequestSchema,
  },
  required: ["database_id"],
  additionalProperties: false,
};

export const GetDatabaseParametersSchema: JSONSchema =
  GetDatabasePathParametersSchema;

export const GetDatabaseResponseSchema: JSONSchema = {
  anyOf: [PartialDatabaseObjectResponseSchema, DatabaseObjectResponseSchema],
};
