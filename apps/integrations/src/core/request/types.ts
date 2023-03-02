import {
  IntegrationAuthentication,
  AuthCredentials,
} from "core/authentication/types";
import { EndpointSpec } from "core/endpoint/types";
import { z } from "zod";

export const HTTPMethodSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
  z.literal("HEAD"),
  z.literal("OPTIONS"),
  z.literal("TRACE"),
]);

export type HTTPMethod = z.infer<typeof HTTPMethodSchema>;

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
