export interface WebhookConfig {
  accessToken: string;
  callbackUrl: string;
  secret: string;
}

export interface NormalizedRequest {
  body: any;
  headers: Record<string, string>;
  searchParams: URLSearchParams;
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

export interface WebhookIntegration {
  keyForSource: (source: unknown) => string;
  registerWebhook: (config: WebhookConfig, source: unknown) => Promise<any>;
  handleWebhookRequest: (
    options: HandleWebhookOptions
  ) =>
    | { status: "ok"; data: ReceivedWebhook }
    | { status: "ignored"; reason: string }
    | { status: "error"; error: string };
}
