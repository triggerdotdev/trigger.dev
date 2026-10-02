import type {
  WebhookVerifierArtifact,
  WebhookSecretProvisioning,
} from "../schemas/webhookConfig.js";

declare const __webhookEvent: unique symbol;

export type WebhookSource<TEvent = unknown> = {
  /** provider tag, e.g. "stripe" | "github" | "custom" */
  provider: string;
  /** data-only verifier artifact (config | preset in P1) */
  verifier: WebhookVerifierArtifact;
  /** who supplies the secret/key; drives the Connect UI (paste vs generate). Defaults to "either". */
  secretProvisioning?: WebhookSecretProvisioning;
  /**
   * Provider-specific instructions for an AI agent registering the endpoint with the provider. The
   * platform wraps it with the endpoint's URL, subscribers and signing-secret steps.
   */
  setupPrompt?: string;
  /** phantom, type-level only; never present at runtime */
  [__webhookEvent]?: TEvent;
};

export type AnyWebhookSource = WebhookSource<any>;

export type InferWebhookEvent<S> = S extends WebhookSource<infer TEvent> ? TEvent : unknown;

/**
 * The endpoint a delivery arrived on. `id` is the endpoint instance (`wh_...`); `declaredId` is the
 * `webhooks.endpoint.define` id. `tenantId` and `externalRef` are unset on the declared instance.
 */
export type WebhookEndpointContext = {
  id: string;
  declaredId: string;
  tenantId?: string;
  externalRef?: string;
  metadata: Record<string, unknown>;
};

/**
 * The envelope the platform delivers to a webhook task run: the verified event, the curated inbound
 * headers and the endpoint it arrived on. `endpoint` is optional so a hand-triggered run type-checks.
 */
export type WebhookRunPayload<TEvent = unknown> = {
  event: TEvent;
  headers: Record<string, string>;
  endpoint?: WebhookEndpointContext;
};

export type CreateWebhookEndpointParams = {
  /** the declared `webhooks.endpoint.define` id */
  endpoint: string;
  tenantId?: string;
  externalRef?: string;
  metadata?: Record<string, unknown>;
};
