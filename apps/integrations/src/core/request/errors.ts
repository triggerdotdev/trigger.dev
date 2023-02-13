import { JSONSchemaError } from "core/schemas/types";

export type RequestError =
  | RequestBodyInvalid
  | ParameterMissing
  | ParametersInvalid
  | ExtraParametersError
  | InsufficientScopesError
  | MissingResponseSpec
  | ResponseBodyInvalid
  | BodyMissing
  | MissingCredentialsError;

export interface RequestBodyInvalid {
  type: "request_body_invalid";
  errors: any[];
}

export interface BodyMissing {
  type: "missing_body";
}

export interface ParameterMissing {
  type: "missing_parameter";
  parameter: {
    name: string;
  };
}

export interface ParametersInvalid {
  type: "parameter_invalid";
  parameter: {
    name: string;
    value: any;
  };
  errors: JSONSchemaError[];
}

export interface ExtraParametersError {
  type: "extra_parameters";
  parameters: Array<{
    name: string;
    value: any;
  }>;
}

export interface MissingCredentialsError {
  type: "missing_credentials";
}

export interface InsufficientScopesError {
  type: "insufficient_scopes";
  missingScopes: string[];
}

export interface MissingResponseSpec {
  type: "no_response_spec";
  status: number;
}

export interface ResponseBodyInvalid {
  type: "response_invalid";
  errors: Array<{ name: string; errors: JSONSchemaError[] }>;
  status: number;
  body?: any;
}
