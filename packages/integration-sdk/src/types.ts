import { z } from "zod";

export type AccessInfo =
  | { type: "oauth2"; accessToken: string }
  | {
      type: "api_key";
      api_key: string;
      additionalFields?: Record<string, string>;
    };

export interface WebhookConfig {
  accessInfo: AccessInfo;
  callbackUrl: string;
  secret: string;
}

export const httpMethods = <const>[
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
];
export type HTTPMethod = (typeof httpMethods)[number];

export interface NormalizedRequest {
  rawBody: string;
  body: any;
  headers: Record<string, string>;
  searchParams: URLSearchParams;
  method: HTTPMethod;
}

export interface NormalizedResponse {
  output: NonNullable<any>;
  context: any;
}

export interface HandleWebhookOptions {
  request: NormalizedRequest;
  secret?: string;
}

export interface ReceivedWebhook {
  id: string;
  event: string;
  payload: any;
  timestamp?: string;
  context?: any;
}

export type PerformRequestOptions = {
  accessInfo: AccessInfo;
  endpoint: string;
  params: any;
  cache?: CacheService;
  metadata?: Record<string, string>;
};

const DisplayPropertySchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const DisplayPropertiesSchema = z.object({
  title: z.string(),
  properties: z.array(DisplayPropertySchema).optional(),
});

export type DisplayProperties = z.infer<typeof DisplayPropertiesSchema>;
export type DisplayProperty = z.infer<typeof DisplayPropertySchema>;

export type WebhookExample = {
  name: string;
  payload: any;
};

export interface PerformedRequestResponse {
  response: NormalizedResponse;
  isRetryable: boolean;
  ok: boolean;
}

export interface RequestIntegration {
  perform: (
    options: PerformRequestOptions
  ) => Promise<PerformedRequestResponse>;
  displayProperties: (endpoint: string, params: any) => DisplayProperties;
}

export interface WebhookIntegration {
  keyForSource: (source: unknown) => string;
  registerWebhook: (config: WebhookConfig, source: unknown) => Promise<any>;
  handleWebhookRequest: (
    options: HandleWebhookOptions
  ) =>
    | { status: "ok"; data: ReceivedWebhook[] }
    | { status: "ignored"; reason: string }
    | { status: "error"; error: string };
  verifyWebhookRequest: (
    options: HandleWebhookOptions
  ) =>
    | { status: "ok"; data: any }
    | { status: "ignored"; reason: string }
    | { status: "error"; error: string };
  displayProperties: (source: unknown) => DisplayProperties;
  examples: (eventName: string) => WebhookExample | undefined;
}

export interface CacheService {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
}

export type InternalIntegration = {
  metadata: ServiceMetadata;
  requests?: RequestIntegration;
  webhooks?: WebhookIntegration;
};

export type ServiceMetadata = {
  name: string;
  service: string;
  icon: string;
  live: boolean;
  authentication: Record<string, OAuth2Authentication | APIKeyAuthentication>;
};

export type OAuth2Authentication = {
  type: "oauth2";
  placement: AuthenticationPlacement;
  authorizationUrl: string;
  tokenUrl: string;
  flow: "accessCode" | "implicit" | "password" | "application";
  scopes: Record<string, string>;
};

export type APIKeyAuthentication = {
  type: "api_key";
  placement: AuthenticationPlacement;
  documentation: string;
  scopes: Record<string, string>;
  additionalFields?: {
    key: string;
    fieldType: "text";
    name: string;
    placeholder?: string;
    description: string;
  }[];
};

type AuthenticationPlacement = HeaderAuthentication;

interface HeaderAuthentication {
  in: "header";
  type: "basic" | "bearer";
  key: string;
}
