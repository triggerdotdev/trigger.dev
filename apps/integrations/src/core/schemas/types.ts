import { JSONSchema7 } from "json-schema";
import { InstanceType } from "@cfworker/json-schema";
import { ErrorObject } from "ajv";

export type JSONSchema = JSONSchema7;
export type JSONSchemaInstanceType = InstanceType;
export type JSONSchemaError = ErrorObject;

export type IntegrationSchema = {
  definitions: Record<string, JSONSchema>;
};

type DefinitionPath = "#/definitions/";
export type SchemaRef = `${DefinitionPath}${string}`;
