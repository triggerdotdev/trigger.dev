import { type ErrorObject } from "ajv";

export type RequestError =
  | RequestBodyInvalid
  | ParameterMissing
  | ParametersInvalid
  | ExtraParametersError
  | InsufficientScopesError
  | MissingResponseSpec
  | ResponseBodyInvalid;

export interface RequestBodyInvalid {
  type: "request_body_invalid";
  errors: any[];
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
  errors: Array<{ name: string; errors: ErrorObject[] }>;
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
  errors: Array<{ name: string; errors: ErrorObject[] }>;
  status: number;
  body?: any;
}
