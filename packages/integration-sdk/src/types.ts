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

export type DisplayProperties = {
  title: string;
  properties?: DisplayProperty[];
};

export type DisplayProperty = { key: string; value: string | number | boolean };

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
  enabledFor: "all" | "admins" | "none";
  authentication: OAuthAuthentication | APIKeyAuthentication;
};

export type OAuthAuthentication = {
  type: "oauth";
  scopes: string[];
};

export type APIKeyAuthentication = {
  type: "api_key";
  header_name: string;
  header_type: "access_token" | "bearer";
  documentation: string;
  additionalFields?: {
    key: string;
    fieldType: "text";
    name: string;
    placeholder?: string;
    description: string;
  }[];
};
