import { RequestData, RequestResponse, RequestSpec } from "core/request/types";
import { JSONSchema } from "core/schemas/types";

export type Endpoint = {
  spec: RequestSpec;
  request: (data: RequestData) => Promise<RequestResponse>;
};

export type HTTPMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "TRACE";

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

interface EndpointSpecParameter {
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
  schema: JSONSchema;
}

interface EndpointSpecMetadata {
  name: string;
  description: string;
  externalDocs?: ExternalDocs;
  tags: string[];
}

interface ExternalDocs {
  description: string;
  url: string;
}
