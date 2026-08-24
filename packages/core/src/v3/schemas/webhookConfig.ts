import { z } from "zod";

// Ingress webhook verification config. Kept in a LEAF module (imports only `z`) so it
// can be consumed by resources.ts / schemas.ts without dragging in the alert-webhook
// `Webhook` union in webhooks.ts, which imports api.js (RunStatus). resources.ts is
// imported by api.ts, so a resources -> webhooks -> api edge would be a module-init cycle.

// Who supplies the signing secret / key, driving the dashboard Connect UI (NOT a provider-name
// switch — it's data on the source). "provider": the provider generates it and you paste it in
// (Stripe, Slack, Svix). "integrator": you choose it, so the dashboard can generate-and-reveal one
// for you to paste into the provider (GitHub, GitLab). "either": offer both.
export const WebhookSecretProvisioning = z.enum(["provider", "integrator", "either"]);
export type WebhookSecretProvisioning = z.infer<typeof WebhookSecretProvisioning>;

// Q9: the provider delivery id can live in a header (GitHub x-github-delivery) or the body (Stripe id).
export const WebhookIdempotencyField = z.object({
  from: z.enum(["header", "body"]),
  name: z.string(),
});
export type WebhookIdempotencyField = z.infer<typeof WebhookIdempotencyField>;

// ── Shared, data-only verification primitives (no per-provider code) ──

// Where a scalar value comes from. Used for the timestamp and for signing-string template vars.
// "signatureField" reads a field parsed out of the signature header (e.g. Stripe `t`).
// "url" is the inbound request URL (e.g. Square signs `{url}{body}`). "constant" is a literal.
export const WebhookValueSource = z.discriminatedUnion("from", [
  z.object({ from: z.literal("header"), name: z.string() }),
  z.object({ from: z.literal("signatureField"), field: z.string() }),
  z.object({ from: z.literal("body"), path: z.string() }),
  z.object({ from: z.literal("url") }),
  z.object({ from: z.literal("constant"), value: z.string() }),
]);
export type WebhookValueSource = z.infer<typeof WebhookValueSource>;

// How to pull the signature value(s) out of one header. All fields optional → the whole
// header value IS the signature (Shopify, Linear). With fieldSeparator+field we select
// named element(s): GitHub `sha256=<hex>`, Stripe `t=…,v1=…`, Svix `v1,<b64> v1,<b64>`.
// Field extraction is multi-valued (rotation / signature lists) → the verifier accepts ANY match.
export const WebhookSignatureExtraction = z.object({
  itemSeparator: z.string().optional(), // split header into elements: Stripe "," · Svix " "
  fieldSeparator: z.string().optional(), // split element into name<sep>value: "=" · Svix ","
  field: z.string().optional(), // element name carrying the signature: "v1" | "sha256" | "v0"
  trim: z.boolean().optional(), // trim each element (WorkOS "t=…, v1=…")
});
export type WebhookSignatureExtraction = z.infer<typeof WebhookSignatureExtraction>;

// Replay protection + a `{timestamp}` template var. Source is a header, an in-signature field
// (Stripe `t`), or a body field (Linear `webhookTimestamp`). Unit defaults to seconds.
export const WebhookTimestampConfig = z.object({
  source: WebhookValueSource,
  unit: z.enum(["seconds", "milliseconds"]).optional(),
  toleranceSeconds: z.number().optional(),
});
export type WebhookTimestampConfig = z.infer<typeof WebhookTimestampConfig>;

// The stored credential transform. Most providers use the secret as-is (utf8). Svix-family
// secrets are `whsec_<base64>` and must be base64-decoded after stripping the prefix.
export const WebhookSecretTransform = z.object({
  encoding: z.enum(["utf8", "base64"]).optional(),
  stripPrefix: z.string().optional(),
});
export type WebhookSecretTransform = z.infer<typeof WebhookSecretTransform>;

// The bytes that get signed. "raw" = the body verbatim. Otherwise a template with `{body}`,
// `{timestamp}` (auto-bound) and any named `vars` (e.g. `{id}` for Svix, `{url}` for Square).
export const WebhookSigningString = z.union([
  z.literal("raw"),
  z.object({
    template: z.string(),
    vars: z.record(WebhookValueSource).optional(),
  }),
]);
export type WebhookSigningString = z.infer<typeof WebhookSigningString>;

/**
 * Body-parsing hint. Some providers send an event as JSON but a SECOND kind of callback (e.g. Slack
 * interactivity) as `application/x-www-form-urlencoded` with the JSON in a single field (Slack: `payload`).
 * When JSON parsing fails, the engine form-decodes and JSON-parses `field`'s value. The signature is over
 * the raw body either way, so verification is unaffected. Generic (a field name), no provider code in the engine.
 */
export const WebhookFormPayload = z.object({
  field: z.string(),
});
export type WebhookFormPayload = z.infer<typeof WebhookFormPayload>;

export const WebhookHmacConfig = z.object({
  scheme: z.literal("hmac"),
  algorithm: z.enum(["sha256", "sha1"]),
  encoding: z.enum(["hex", "base64"]), // explicit, no auto-detect (design decision 3)
  signatureHeader: z.string(),
  signature: WebhookSignatureExtraction.optional(), // omit = bare whole-header value
  timestamp: WebhookTimestampConfig.optional(),
  signingString: WebhookSigningString,
  secret: WebhookSecretTransform.optional(), // omit = utf8, no prefix strip
  idempotencyField: WebhookIdempotencyField.optional(),
  formPayload: WebhookFormPayload.optional(),
});
export type WebhookHmacConfig = z.infer<typeof WebhookHmacConfig>;

// Asymmetric (public-key) signatures: the provider signs with a private key, we verify with
// their public key. Same parsing/template primitives as HMAC; only the final verify differs.
// Covers Discord (ed25519), SendGrid (ecdsa-p256), RSA providers. Dynamic key fetch (PayPal
// cert URL / JWKS) is out of scope → the custom-bundle escape hatch.
export const WebhookAsymmetricConfig = z.object({
  scheme: z.literal("asymmetric"),
  algorithm: z.enum(["ed25519", "ecdsa-p256", "rsa-sha256"]),
  encoding: z.enum(["hex", "base64"]), // how the signature value is encoded
  signatureHeader: z.string(),
  signature: WebhookSignatureExtraction.optional(),
  timestamp: WebhookTimestampConfig.optional(),
  signingString: WebhookSigningString,
  // How the stored public key is encoded: a PEM string, base64 of DER SPKI (SendGrid),
  // or raw key bytes (ed25519 raw, Discord). Defaults to "pem".
  publicKeyEncoding: z.enum(["pem", "spki-der-base64", "raw-hex", "raw-base64"]).optional(),
  idempotencyField: WebhookIdempotencyField.optional(),
});
export type WebhookAsymmetricConfig = z.infer<typeof WebhookAsymmetricConfig>;

export const WebhookSharedSecretConfig = z.object({
  scheme: z.literal("shared-secret"),
  placement: z.enum(["header", "bearer", "basic", "body"]),
  fieldName: z.string().optional(),
  idempotencyField: WebhookIdempotencyField.optional(),
});
export type WebhookSharedSecretConfig = z.infer<typeof WebhookSharedSecretConfig>;

export const WebhookUrlSecretConfig = z.object({
  scheme: z.literal("url-secret"),
  placement: z.enum(["query", "path"]),
  paramName: z.string(),
  idempotencyField: WebhookIdempotencyField.optional(),
});
export type WebhookUrlSecretConfig = z.infer<typeof WebhookUrlSecretConfig>;

export const WebhookVerifierConfig = z.discriminatedUnion("scheme", [
  WebhookHmacConfig,
  WebhookSharedSecretConfig,
  WebhookUrlSecretConfig,
  WebhookAsymmetricConfig,
]);
export type WebhookVerifierConfig = z.infer<typeof WebhookVerifierConfig>;

// ── Provider handshake: a signed request that must get a synchronous echo, not a recorded/routed
// delivery (Slack url_verification, Discord PING). Generic + data-only: if the verified body's
// `matchPath` equals `matchValue`, ingest responds 200 with the body's `respondPath` value. ──
export const WebhookHandshakeConfig = z.object({
  matchPath: z.string(), // dotted path into the body, e.g. "type"
  matchValue: z.string(), // e.g. "url_verification"
  respondPath: z.string(), // dotted path to echo, e.g. "challenge"
});
export type WebhookHandshakeConfig = z.infer<typeof WebhookHandshakeConfig>;

// ── Verifier artifact: data-only tagged union stored on WebhookEndpoint.verifierArtifact ──
export const WebhookVerifierArtifact = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config"),
    config: WebhookVerifierConfig,
    handshake: WebhookHandshakeConfig.optional(),
  }),
  z.object({
    kind: z.literal("preset"),
    preset: z.string(),
    config: WebhookVerifierConfig,
    handshake: WebhookHandshakeConfig.optional(),
  }),
  z.object({ kind: z.literal("bundle"), bundleUrl: z.string(), hash: z.string() }), // P3 seam
]);
export type WebhookVerifierArtifact = z.infer<typeof WebhookVerifierArtifact>;

// ── Routing target: data-only tagged union stored on WebhookEndpoint.routingTarget ──
// P1 implements only { type: "task" }. The session variant routes a delivery to a find-or-created
// session: keyTemplate resolves the externalId, deliverAs selects the mode. "action" (chat.event)
// carries actionType → the onAction envelope's action.type; "message" (channels) carries connectorId
// → the run resolves the connector's inbound() mapper and runs a turn.
export const WebhookRoutingTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task"), taskId: z.string() }),
  z.object({
    type: z.literal("session"),
    taskIdentifier: z.string(),
    keyTemplate: z.string(),
    deliverAs: z.enum(["action", "message"]),
    actionType: z.string().optional(),
    connectorId: z.string().optional(),
    triggerConfigTemplate: z.record(z.unknown()).optional(),
    // Gate session CREATION: an event that already resolves to an existing session always resumes it,
    // but a key with no session is only started when the event matches this filter. Absent => always start.
    startOn: z.string().optional(),
  }),
]);
export type WebhookRoutingTarget = z.infer<typeof WebhookRoutingTarget>;

// ── Data-only verdict the engine verifier returns (M5 consumes) ──
export const WebhookVerifierResult = z.object({
  ok: z.boolean(),
  idempotencyKey: z.string(),
  parsedEvent: z.unknown().optional(),
  error: z.string().optional(),
});
export type WebhookVerifierResult = z.infer<typeof WebhookVerifierResult>;

// ── Preset event-type unions (P1 ships these TYPE-only) ──
export type StripeWebhookEvent = {
  id: string;
  object: "event";
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
  [k: string]: unknown;
};

export type GitHubWebhookEvent = {
  [k: string]: unknown;
};
