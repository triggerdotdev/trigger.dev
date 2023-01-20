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

export interface NormalizedRequest {
  body: any;
  headers: Record<string, string>;
  searchParams: URLSearchParams;
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
};

export type DisplayProperties = {
  title: string;
  properties?: DisplayProperty[];
};

export type DisplayProperty = { key: string; value: string | number | boolean };

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
    | { status: "ok"; data: ReceivedWebhook }
    | { status: "ignored"; reason: string }
    | { status: "error"; error: string };
  displayProperties: (source: unknown) => DisplayProperties;
}

export interface CacheService {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
}
