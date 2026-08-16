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
  /** phantom, type-level only; never present at runtime */
  [__webhookEvent]?: TEvent;
};

export type AnyWebhookSource = WebhookSource<any>;

export type InferWebhookEvent<S> = S extends WebhookSource<infer TEvent> ? TEvent : unknown;

// The envelope the platform delivers to a webhook task run: the verified event body plus the
// inbound request headers. The SDK's webhook() run unwraps this into onEvent({ event, headers }).
// Kept here so the trigger side (webapp) and the receive side (SDK) agree on the shape.
export type WebhookRunPayload<TEvent = unknown> = {
  event: TEvent;
  headers: Record<string, string>;
};

// ── P2 seam: TYPE ONLY, no runtime function ──
export type CreateWebhookEndpointParams = {
  /** declared webhook() id (string ref; GOLDEN LAW, never the value) */
  handler: string;
  tenantId?: string;
  externalRef?: string;
  metadata?: Record<string, unknown>;
};
