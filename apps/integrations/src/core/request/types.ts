import {
  IntegrationAuthentication,
  AuthCredentials,
} from "core/authentication/types";
import { HTTPMethod, EndpointSpec } from "core/endpoint/types";

export interface FetchConfig {
  url: string;
  method: HTTPMethod;
  headers: Record<string, string>;
  body?: any;
}

export interface RequestSpec {
  baseUrl: string;
  endpointSpec: EndpointSpec;
  authentication: IntegrationAuthentication;
}
export interface RequestData {
  parameters?: Record<string, any>;
  body?: any;
  credentials?: AuthCredentials;
}

export interface RequestResponse {
  success: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: any;
}
