import { RequestData, RequestResponse, RequestSpec } from "core/request/types";
import { JSONSchema } from "core/schemas/types";
import { z } from "zod";

export type Endpoint = {
  spec: RequestSpec;
  request: (data: RequestData) => Promise<RequestResponse>;
};

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

export interface EndpointSpec {
  path: string;
  method: HTTPMethod;
  metadata: EndpointSpecMetadata;
  parameters?: EndpointSpecParameter[];
  security?: Record<string, string[]>;
  request: EndpointSpecRequest;
  responses: { default: EndpointSpecResponse[] } & Record<
    string,
    EndpointSpecResponse[]
  >;
}

export interface EndpointSpecParameter {
  name: string;
  description: string;
  in: "query" | "path" | "header";
  required?: boolean;
  schema: JSONSchema;
}

interface EndpointSpecRequest {
  headers?: Record<string, string>;
  body?: {
    schema: JSONSchema;
  };
}

export interface EndpointSpecResponse {
  success: boolean;
  name: string;
  description?: string;
  schema?: JSONSchema;
}

export interface EndpointSpecMetadata {
  name: string;
  description: string;
  displayProperties: {
    title: string;
  };
  externalDocs?: ExternalDocs;
  tags: string[];
}

interface ExternalDocs {
  description: string;
  url: string;
}
