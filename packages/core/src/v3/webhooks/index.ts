import type {
  WebhookAsymmetricConfig,
  WebhookHmacConfig,
  WebhookSecretProvisioning,
  WebhookVerifierConfig,
} from "../schemas/webhookConfig.js";

/**
 * Preset verifier-config builders: the single source of truth for how each supported provider signs.
 * The public SDK `webhooks.stripe()` producers wrap these (attaching provider + secretProvisioning +
 * the phantom event type), and `@internal/webhook-sources` uses them to sign-and-verify its samples.
 * These carry zero SDK dependency (pure `WebhookVerifierConfig` data), so they live in core.
 */

export function stripeVerifierConfig(opts?: { toleranceSeconds?: number }): WebhookHmacConfig {
  return {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "hex",
    signatureHeader: "stripe-signature",
    signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
    timestamp: {
      source: { from: "signatureField", field: "t" },
      toleranceSeconds: opts?.toleranceSeconds ?? 300,
    },
    signingString: { template: "{timestamp}.{body}" },
    idempotencyField: { from: "body", name: "id" },
  };
}

export function githubVerifierConfig(): WebhookHmacConfig {
  return {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "hex",
    signatureHeader: "x-hub-signature-256",
    signature: { fieldSeparator: "=", field: "sha256" },
    signingString: "raw",
    idempotencyField: { from: "header", name: "x-github-delivery" },
  };
}

export function svixVerifierConfig(): WebhookHmacConfig {
  return {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "base64",
    signatureHeader: "svix-signature",
    signature: { itemSeparator: " ", fieldSeparator: ",", field: "v1" },
    timestamp: { source: { from: "header", name: "svix-timestamp" }, toleranceSeconds: 300 },
    signingString: {
      template: "{id}.{timestamp}.{body}",
      vars: { id: { from: "header", name: "svix-id" } },
    },
    secret: { encoding: "base64", stripPrefix: "whsec_" },
    idempotencyField: { from: "header", name: "svix-id" },
  };
}

export function squareVerifierConfig(): WebhookHmacConfig {
  return {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "base64",
    signatureHeader: "x-square-hmacsha256-signature",
    signature: {},
    signingString: { template: "{url}{body}", vars: { url: { from: "url" } } },
    idempotencyField: { from: "body", name: "event_id" },
  };
}

export function discordVerifierConfig(opts?: {
  publicKeyEncoding?: "raw-hex" | "pem";
}): WebhookAsymmetricConfig {
  return {
    scheme: "asymmetric",
    algorithm: "ed25519",
    encoding: "hex",
    signatureHeader: "x-signature-ed25519",
    signature: {},
    timestamp: { source: { from: "header", name: "x-signature-timestamp" } },
    signingString: { template: "{timestamp}{body}" },
    publicKeyEncoding: opts?.publicKeyEncoding ?? "raw-hex",
  };
}

export const WEBHOOK_PRESET_IDS = [
  "custom",
  "stripe",
  "github",
  "svix",
  "square",
  "discord",
] as const;
export type WebhookPresetId = (typeof WEBHOOK_PRESET_IDS)[number];

/**
 * Generic HMAC verifier-config builder. The per-provider configs below are concise declarative calls;
 * each names the signature header, how the signature (and optional timestamp) is parsed out of it, and
 * the bytes that get signed. The engine signer/verifier are the single implementation.
 */
function hmacVerifierConfig(opts: {
  header: string;
  algorithm?: "sha256" | "sha1";
  encoding?: "hex" | "base64";
  field?: string;
  fieldSeparator?: string;
  itemSeparator?: string;
  trim?: boolean;
  signingTemplate?: string;
  timestamp?:
    | { from: "header"; name: string; unit?: "seconds" | "milliseconds" }
    | { from: "signatureField"; field: string; unit?: "seconds" | "milliseconds" };
  toleranceSeconds?: number;
}): WebhookHmacConfig {
  const signature: WebhookHmacConfig["signature"] = {};
  if (opts.itemSeparator) signature.itemSeparator = opts.itemSeparator;
  if (opts.field) {
    signature.fieldSeparator = opts.fieldSeparator ?? "=";
    signature.field = opts.field;
  }
  if (opts.trim) signature.trim = true;

  const config: WebhookHmacConfig = {
    scheme: "hmac",
    algorithm: opts.algorithm ?? "sha256",
    encoding: opts.encoding ?? "hex",
    signatureHeader: opts.header,
    signature,
    signingString: opts.signingTemplate ? { template: opts.signingTemplate } : "raw",
  };

  if (opts.timestamp) {
    config.timestamp = {
      source:
        opts.timestamp.from === "header"
          ? { from: "header", name: opts.timestamp.name }
          : { from: "signatureField", field: opts.timestamp.field },
      ...(opts.timestamp.unit ? { unit: opts.timestamp.unit } : {}),
      ...(opts.toleranceSeconds ? { toleranceSeconds: opts.toleranceSeconds } : {}),
    };
  }

  return config;
}

/**
 * Per-provider verifier configs for providers whose signature is a plain HMAC variant that maps onto
 * the config primitives (a different header name / prefix / signing template than the shared presets,
 * but no new verifier capability). Each is round-trip tested in @internal/webhook-sources and wrapped
 * by a `webhooks.X()` SDK producer. Providers needing asymmetric verification, hex-decoded keys, or
 * URL+param signing are NOT here (they ship sample-only until the verifier gains those).
 */
export const webhookProviderConfigs = {
  slack: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-slack-signature",
        field: "v0",
        signingTemplate: "v0:{timestamp}:{body}",
        timestamp: { from: "header", name: "x-slack-request-timestamp" },
        toleranceSeconds: 300,
      }),
  },
  zoom: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-zm-signature",
        field: "v0",
        signingTemplate: "v0:{timestamp}:{body}",
        timestamp: { from: "header", name: "x-zm-request-timestamp" },
        toleranceSeconds: 300,
      }),
  },
  calendly: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "calendly-webhook-signature",
        itemSeparator: ",",
        field: "v1",
        signingTemplate: "{timestamp}.{body}",
        timestamp: { from: "signatureField", field: "t" },
        toleranceSeconds: 300,
      }),
  },
  "cal-com": {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-cal-signature-256" }),
  },
  sentry: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "sentry-hook-signature" }),
  },
  pagerduty: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-pagerduty-signature", field: "v1" }),
  },
  vercel: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-vercel-signature", algorithm: "sha1" }),
  },
  linear: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "linear-signature" }),
  },
  notion: {
    secretProvisioning: "provider",
    config: () => hmacVerifierConfig({ header: "x-notion-signature", field: "sha256" }),
  },
  typeform: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({ header: "typeform-signature", field: "sha256", encoding: "base64" }),
  },
  docusign: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-docusign-signature-1", encoding: "base64" }),
  },
  jira: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-hub-signature", field: "sha256" }),
  },
  intercom: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({ header: "x-hub-signature", field: "sha1", algorithm: "sha1" }),
  },
  zendesk: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "x-zendesk-webhook-signature",
        encoding: "base64",
        signingTemplate: "{timestamp}{body}",
        timestamp: { from: "header", name: "x-zendesk-webhook-signature-timestamp" },
      }),
  },
  attio: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "attio-signature" }),
  },
  workos: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "workos-signature",
        itemSeparator: ",",
        field: "v1",
        trim: true,
        signingTemplate: "{timestamp}.{body}",
        timestamp: { from: "signatureField", field: "t", unit: "milliseconds" },
      }),
  },
  elevenlabs: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "elevenlabs-signature",
        itemSeparator: ",",
        field: "v0",
        signingTemplate: "{timestamp}.{body}",
        timestamp: { from: "signatureField", field: "t" },
        toleranceSeconds: 1800,
      }),
  },
  vapi: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-vapi-signature" }),
  },
  retell: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-retell-signature",
        itemSeparator: ",",
        field: "d",
        signingTemplate: "{body}{timestamp}",
        timestamp: { from: "signatureField", field: "v", unit: "milliseconds" },
      }),
  },
  shopify: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-shopify-hmac-sha256", encoding: "base64" }),
  },
} satisfies Record<
  string,
  { secretProvisioning: WebhookSecretProvisioning; config: () => WebhookVerifierConfig }
>;

export type WebhookProviderId = keyof typeof webhookProviderConfigs;

export * from "../schemas/webhookConfig.js";
