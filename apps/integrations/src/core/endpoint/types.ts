import { JSONPointer } from "core/common/pointer";
import {
  HTTPMethod,
  RequestData,
  RequestResponse,
  RequestSpec,
} from "core/request/types";
import { JSONSchema } from "core/schemas/types";

export type Endpoint = {
  spec: RequestSpec;
  request: (data: RequestData) => Promise<RequestResponse>;
};

export interface EndpointSpec {
  path: string;
  method: HTTPMethod;
  metadata: EndpointSpecMetadata;
  parameters?: EndpointSpecParameter[];
  security?: Record<string, string[]>;
  request: EndpointSpecRequest;
  responses: EndpointSpecResponse[];
}

export type EndpointSpecParameter = {
  name: string;
  description: string;
  required?: boolean;
  schema: JSONSchema;
} & (EndpointSpecParameterUrl | EndpointSpecParameterHeader);

type EndpointSpecParameterUrl = {
  in: "query" | "path";
};

type EndpointSpecParameterHeader = {
  in: "header";
};

interface EndpointSpecRequest {
  headers?: Record<string, string>;
  body?: {
    schema: JSONSchema;
  };
}

export interface EndpointSpecResponse {
  /** If you return true then this response is the relevant one */
  matches: ({
    statusCode,
    headers,
    body,
  }: {
    statusCode: number;
    headers: Record<string, string>;
    body: any;
  }) => boolean;
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
