export interface WebhookConfig {
  accessToken: string;
  callbackUrl: string;
  secret: string;
}

export interface NormalizedWebhookRequest {
  body: any;
  headers: Record<string, string>;
  searchParams: URLSearchParams;
}

export interface HandleWebhookOptions {
  request: NormalizedWebhookRequest;
  secret?: string;
  params: unknown;
}

export interface WebhookIntegration {
  registerWebhook: (config: WebhookConfig, params: unknown) => Promise<any>;
  handleWebhookRequest: (options: HandleWebhookOptions) => any;
}
