import type {
  WebhookAsymmetricConfig,
  WebhookHmacConfig,
  WebhookSecretProvisioning,
  WebhookValueSource,
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

/**
 * Standard Webhooks (https://www.standardwebhooks.com): the same scheme Svix uses, under the spec's
 * vendor-neutral header names (`webhook-id` / `webhook-timestamp` / `webhook-signature`). Providers that
 * implement the spec directly (Composio, OpenAI, Replicate, GitLab's signing token, and others) send
 * these; Svix itself sends both sets.
 */
export function standardWebhooksVerifierConfig(): WebhookHmacConfig {
  return {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "base64",
    signatureHeader: "webhook-signature",
    signature: { itemSeparator: " ", fieldSeparator: ",", field: "v1" },
    timestamp: { source: { from: "header", name: "webhook-timestamp" }, toleranceSeconds: 300 },
    signingString: {
      template: "{id}.{timestamp}.{body}",
      vars: { id: { from: "header", name: "webhook-id" } },
    },
    secret: { encoding: "base64", stripPrefix: "whsec_" },
    idempotencyField: { from: "header", name: "webhook-id" },
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
  "standard-webhooks",
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
  additionalHeaders?: string[];
  algorithm?: "sha256" | "sha1";
  encoding?: "hex" | "base64";
  field?: string;
  fieldSeparator?: string;
  itemSeparator?: string;
  trim?: boolean;
  signingTemplate?: string;
  signingVars?: Record<string, WebhookValueSource>;
  timestamp?: (
    | { from: "header"; name: string; fallback?: string[] }
    | { from: "signatureField"; field: string }
    | { from: "body"; path: string }
  ) & { unit?: "seconds" | "milliseconds"; format?: "unix" | "iso8601" | "http-date" };
  toleranceSeconds?: number;
  idempotencyField?: WebhookHmacConfig["idempotencyField"];
  formPayload?: WebhookHmacConfig["formPayload"];
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
    ...(opts.additionalHeaders ? { additionalSignatureHeaders: opts.additionalHeaders } : {}),
    signature,
    signingString: opts.signingTemplate
      ? {
          template: opts.signingTemplate,
          ...(opts.signingVars ? { vars: opts.signingVars } : {}),
        }
      : "raw",
  };

  if (opts.timestamp) {
    config.timestamp = {
      source:
        opts.timestamp.from === "header"
          ? {
              from: "header",
              name: opts.timestamp.name,
              ...(opts.timestamp.fallback ? { fallback: opts.timestamp.fallback } : {}),
            }
          : opts.timestamp.from === "body"
            ? { from: "body", path: opts.timestamp.path }
            : { from: "signatureField", field: opts.timestamp.field },
      ...(opts.timestamp.unit ? { unit: opts.timestamp.unit } : {}),
      ...(opts.timestamp.format ? { format: opts.timestamp.format } : {}),
      ...(opts.toleranceSeconds ? { toleranceSeconds: opts.toleranceSeconds } : {}),
    };
  }
  if (opts.idempotencyField) config.idempotencyField = opts.idempotencyField;
  if (opts.formPayload) config.formPayload = opts.formPayload;

  return config;
}

export type HookdeckSourceOptions = {
  /**
   * The header prefix set in the Hookdeck project's settings, when it was changed from `x-hookdeck`.
   * Hookdeck renames its event id header with it (`<prefix>-eventid`), which retries dedupe on. The
   * signature headers keep the `x-hookdeck-` name whatever the prefix.
   */
  headerPrefix?: string;
};

function hookdeckHeaderPrefix(opts?: HookdeckSourceOptions): string {
  return (opts?.headerPrefix?.trim() || "x-hookdeck").toLowerCase().replace(/-+$/, "");
}

/**
 * Per-provider verifier configs for providers whose signature maps onto the config primitives: a plain
 * HMAC variant (a different header name / prefix / signing template than the shared presets, but no
 * new verifier capability), a shared Svix or Standard Webhooks config under the provider's own name, or
 * a shared secret. Each is round-trip tested in @internal/webhook-sources and wrapped by a
 * `webhooks.X()` SDK producer. Providers needing asymmetric verification, hex-decoded keys, or
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
        idempotencyField: { from: "body", name: "event_id" },
        formPayload: { field: "payload" },
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
    config: () =>
      hmacVerifierConfig({
        header: "x-pagerduty-signature",
        field: "v1",
        idempotencyField: { from: "header", name: "x-webhook-id" },
      }),
  },
  vercel: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "x-vercel-signature",
        algorithm: "sha1",
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  linear: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "linear-signature",
        timestamp: { from: "body", path: "webhookTimestamp", unit: "milliseconds" },
        toleranceSeconds: 60,
        idempotencyField: { from: "header", name: "linear-delivery" },
      }),
  },
  notion: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-notion-signature",
        field: "sha256",
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  typeform: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "typeform-signature",
        field: "sha256",
        encoding: "base64",
        idempotencyField: { from: "body", name: "event_id" },
      }),
  },
  docusign: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-docusign-signature-1", encoding: "base64" }),
  },
  jira: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "x-hub-signature",
        field: "sha256",
        idempotencyField: { from: "header", name: "x-atlassian-webhook-identifier" },
      }),
  },
  intercom: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "x-hub-signature",
        field: "sha1",
        algorithm: "sha1",
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  zendesk: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "x-zendesk-webhook-signature",
        encoding: "base64",
        signingTemplate: "{timestamp}{body}",
        timestamp: { from: "header", name: "x-zendesk-webhook-signature-timestamp" },
        idempotencyField: { from: "header", name: "x-zendesk-webhook-invocation-id" },
      }),
  },
  attio: {
    secretProvisioning: "integrator",
    config: () =>
      hmacVerifierConfig({
        header: "attio-signature",
        idempotencyField: { from: "header", name: "idempotency-key" },
      }),
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
        idempotencyField: { from: "body", name: "id" },
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
        toleranceSeconds: 300,
      }),
  },
  shopify: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-shopify-hmac-sha256",
        encoding: "base64",
        idempotencyField: { from: "header", name: "x-shopify-webhook-id" },
      }),
  },
  loops: {
    secretProvisioning: "provider",
    config: standardWebhooksVerifierConfig,
  },
  granola: {
    secretProvisioning: "provider",
    config: standardWebhooksVerifierConfig,
  },
  autumn: {
    secretProvisioning: "provider",
    config: svixVerifierConfig,
  },
  metronome: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "metronome-webhook-signature",
        signingTemplate: "{date}\n{body}",
        signingVars: { date: { from: "header", name: "x-metronome-date", fallback: ["date"] } },
        timestamp: {
          from: "header",
          name: "x-metronome-date",
          fallback: ["date"],
          format: "http-date",
        },
        toleranceSeconds: 300,
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  mux: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "mux-signature",
        itemSeparator: ",",
        field: "v1",
        signingTemplate: "{timestamp}.{body}",
        timestamp: { from: "signatureField", field: "t" },
        toleranceSeconds: 300,
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  tailscale: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "tailscale-webhook-signature",
        itemSeparator: ",",
        field: "v1",
        signingTemplate: "{timestamp}.{body}",
        timestamp: { from: "signatureField", field: "t" },
        toleranceSeconds: 300,
      }),
  },
  langfuse: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-langfuse-signature",
        itemSeparator: ",",
        field: "v1",
        signingTemplate: "{timestamp}.{body}",
        timestamp: { from: "signatureField", field: "t" },
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  infisical: {
    secretProvisioning: "integrator",
    config: () => hmacVerifierConfig({ header: "x-infisical-signature", itemSeparator: ";" }),
  },
  planetscale: {
    secretProvisioning: "provider",
    config: () => hmacVerifierConfig({ header: "x-planetscale-signature" }),
  },
  plain: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "plain-request-signature",
        timestamp: {
          from: "body",
          path: "webhookMetadata.webhookDeliveryAttemptTimestamp",
          format: "iso8601",
        },
        toleranceSeconds: 300,
        idempotencyField: { from: "body", name: "id" },
      }),
  },
  firecrawl: {
    secretProvisioning: "provider",
    config: () =>
      hmacVerifierConfig({
        header: "x-firecrawl-signature",
        field: "sha256",
        idempotencyField: { from: "body", name: "webhookId" },
      }),
  },
  hookdeck: {
    secretProvisioning: "provider",
    config: (opts?: HookdeckSourceOptions) =>
      hmacVerifierConfig({
        header: "x-hookdeck-signature",
        additionalHeaders: ["x-hookdeck-signature-2"],
        encoding: "base64",
        idempotencyField: { from: "header", name: `${hookdeckHeaderPrefix(opts)}-eventid` },
      }),
  },
  supabase: {
    secretProvisioning: "integrator",
    config: (): WebhookVerifierConfig => ({ scheme: "shared-secret", placement: "bearer" }),
  },
} satisfies Record<
  string,
  { secretProvisioning: WebhookSecretProvisioning; config: () => WebhookVerifierConfig }
>;

export type WebhookProviderId = keyof typeof webhookProviderConfigs;

const svixFamilySetupPrompt = [
  "The provider issues the signing secret (it starts with whsec_) when an endpoint is added.",
  "Add the webhook URL as an endpoint in the provider's webhook settings or through its API, subscribe it to the event types the subscribers' filters need, then read the endpoint's signing secret and store it on Trigger.dev.",
].join("\n");

/**
 * Setup instructions for an AI agent, per preset or provider. SDK producers attach these as the
 * source's `setupPrompt`; the platform wraps them with the endpoint URL, subscribers and secret steps.
 */
export const webhookSetupPrompts: Partial<Record<WebhookPresetId | WebhookProviderId, string>> = {
  stripe: [
    "Stripe issues the signing secret when a webhook endpoint is created, and returns it only in the create response.",
    "Create the endpoint with the Stripe CLI or API, not the Dashboard, so you can read the secret from the response:",
    '  stripe webhook_endpoints create -d url="<webhook URL>" -d "enabled_events[]=<event type>"',
    "or POST https://api.stripe.com/v1/webhook_endpoints with `url` and `enabled_events[]`. The response's `secret` field is the signing secret.",
    "Choose enabled_events from the subscribers' filters, which compare `event.type`. Use `*` only when a subscriber has no filter.",
    "Use a test mode key for dev and staging environments and a live mode key for production.",
  ].join("\n"),
  github: [
    "You choose the secret for a GitHub webhook, so generate it on Trigger.dev first and then give it to GitHub.",
    "For a repository webhook, with the gh CLI:",
    '  gh api repos/OWNER/REPO/hooks -f name=web -f "config[url]=<webhook URL>" -f "config[content_type]=json" -f "config[secret]=<secret>" -f "events[]=<event>" -F active=true',
    "Use orgs/ORG/hooks for an organization webhook. For a GitHub App, set the webhook URL and secret in the app's settings.",
    "`content_type` must be json. GitHub sends the event name in the x-github-event header; choose events from the subscribers' filters, or `*` for all.",
    "If the repository or organization isn't clear from the workspace (for example its git remote), ask the user.",
  ].join("\n"),
  svix: svixFamilySetupPrompt,
  "standard-webhooks": svixFamilySetupPrompt,
  discord: [
    "These settings are in the Discord Developer Portal (https://discord.com/developers/applications); tell the user each step.",
    "1. Open the application, then its Webhooks page. Set the Endpoint URL to the webhook URL, turn Events on and select the event types the subscribers need. Discord sends a PING that the endpoint answers once it is deployed.",
    "2. The public key is on the application's General Information page, under Public Key.",
  ].join("\n"),
  shopify: [
    "Shopify signs webhooks with the app's client secret, or for webhooks created in the store admin, with the key shown on that page.",
    "For an app, add a subscription to shopify.app.toml and run `shopify app deploy`:",
    '  [[webhooks.subscriptions]]\n  topics = ["orders/create"]\n  uri = "<webhook URL>"',
    "or create it with the Admin API's webhookSubscriptionCreate mutation. The client secret is in the app's settings in the Shopify Dev Dashboard.",
    "For a store without an app, add the webhook under Settings > Notifications > Webhooks in the store admin; the signing key is shown on that page.",
    "Choose topics from the subscribers' filters, which compare `header.x-shopify-topic`, and use the JSON format.",
  ].join("\n"),
  loops: [
    "These settings are in Loops; tell the user each step.",
    "In Settings > Webhooks, add the webhook URL as the endpoint and select the events the subscribers need. Loops shows the endpoint's signing secret (it starts with whsec_); store it on Trigger.dev.",
    "The settings page can send a `testing.testEvent` to confirm delivery.",
    "Subscribers' filters compare `event.eventName`, for example `email.delivered`.",
  ].join("\n"),
  granola: [
    "Granola webhooks need a Business or Enterprise plan.",
    "Create the endpoint under Settings > Connectors > Webhooks (or a folder's Integrations > Webhooks to limit it to that folder), or with POST https://public-api.granola.ai/v1/webhook-endpoints and an API key. The signing secret (it starts with whsec_) is returned once, at creation; store it on Trigger.dev.",
    "Deliveries carry the note id but not its content; fetch the note with Granola's API in the handler.",
    "Subscribers' filters compare `event.event_type`, for example `note.generated`.",
  ].join("\n"),
  autumn: [
    "Autumn's webhooks are in beta, and Autumn support turns them on per account.",
    "Once they are on, add the webhook URL as an endpoint in the Autumn dashboard's webhook settings and select the event types the subscribers need. Autumn delivers through Svix, which shows the endpoint's signing secret (it starts with whsec_); store it on Trigger.dev.",
    "Subscribers' filters compare `event.type`, for example `billing.updated`.",
  ].join("\n"),
  supabase: [
    "Supabase database webhooks aren't signed, so the endpoint checks a shared secret you choose. Generate it on Trigger.dev first.",
    "On the Database Webhooks page of the Supabase dashboard, create a webhook on the table and events (INSERT, UPDATE, DELETE) the subscribers need, with type HTTP Request, method POST and the webhook URL.",
    "Under HTTP Headers add `Authorization` with the value `Bearer <secret>`.",
    "Subscribers' filters compare `event.type` and `event.table`.",
  ].join("\n"),
  metronome: [
    "These settings are in the Metronome app; tell the user each step.",
    "1. Go to Developer > Notifications > Webhooks > Add and enter the webhook URL. Each webhook has its own secret key; copy it and store it as the endpoint's signing secret.",
    "2. Create the notifications the subscribers need (for example a low credit balance alert) under Developer > Notifications > Create Notification.",
    "Subscribers' filters compare `event.type`.",
  ].join("\n"),
  mux: [
    "Mux issues a signing secret for each webhook endpoint, and webhooks belong to one Mux environment.",
    "In the Mux dashboard's webhook settings (https://dashboard.mux.com/settings/webhooks), select the environment the app uses, add the webhook URL, then copy that webhook's signing secret. The Mux Webhooks API can also create the endpoint.",
    "Mux sends every event in the environment. Subscribers' filters compare `event.type`, for example `video.asset.ready`.",
  ].join("\n"),
  tailscale: [
    "These settings are in the Tailscale admin console; tell the user each step. Adding a webhook needs the Owner, Admin, Network admin or IT admin role.",
    "1. On the Webhooks page select Add endpoint, enter the webhook URL, and choose the event categories or events the subscribers need.",
    "2. Tailscale shows the webhook secret once, in a popup right after the endpoint is added. Copy it then; it can't be shown again.",
    "3. Use the endpoint's menu > Test endpoint > Send test event to confirm delivery.",
    "Each request body is a JSON array of events, and Tailscale can batch several into one request. Subscribers' filters match on any event with `event any ( type == 'nodeCreated' )`; a handler should process every event in the array.",
  ].join("\n"),
  langfuse: [
    "These settings are in the Langfuse UI; tell the user each step.",
    "1. In the project, go to Prompts > Automations > Create Automation. Choose the prompt version event and the actions (created, updated, deleted) the subscribers need, optionally limit it to specific prompts, and set the request URL to the webhook URL.",
    "2. Langfuse shows the signing secret (it starts with lf-whsec_) when the webhook is created, and can regenerate it later.",
    "Subscribers' filters compare `event.type` and `event.action`.",
  ].join("\n"),
  infisical: [
    "You choose the secret for an Infisical webhook, so generate it on Trigger.dev first.",
    "In Infisical, go to Project Settings > Webhooks and create a General webhook with the webhook URL, optionally limited to an environment and secret path, and paste the secret into its secret key field.",
    "The secret key is required here: Infisical only signs a webhook that has one, and the endpoint rejects unsigned deliveries.",
    "Subscribers' filters compare `event.event`, for example `secrets.modified`.",
  ].join("\n"),
  planetscale: [
    "These settings are in PlanetScale; tell the user each step. Adding a webhook needs the database administrator role. The `pscale webhook` CLI command and the PlanetScale API can also manage webhooks.",
    "1. Select the database, then Settings > Webhooks > Add webhook. Enter the webhook URL and select the events the subscribers need.",
    "2. In the webhook's ellipsis menu, click Show secret and store it as the endpoint's signing secret.",
    "3. Test webhook in the same menu sends a `webhook.test` event (at most once every 20 seconds).",
    "Subscribers' filters compare `event.event`, for example `branch.ready`.",
  ].join("\n"),
  plain: [
    "Plain signs every webhook with one workspace-wide HMAC secret, which a workspace admin views or generates under Settings > Request signing. Regenerating it changes the secret for all of the workspace's webhook targets, so read the existing one if it is already in use.",
    "Add the target under Settings > Webhooks > Add webhook target, with the webhook URL and the events the subscribers need.",
    "Subscribers' filters compare `event.type`, for example `thread.thread_created`.",
  ].join("\n"),
  firecrawl: [
    "Firecrawl signs webhooks with one account-wide secret, shown in the Advanced tab of the account settings.",
    'Firecrawl has no webhook settings page: each crawl, batch scrape, extract or agent request carries its own `webhook` object. Add `webhook: { url: "<webhook URL>", events: [...] }` to the requests the code makes (for a crawl the events are started, page and completed).',
    "Subscribers' filters compare `event.type`, which is prefixed with the operation, for example `crawl.completed`.",
  ].join("\n"),
  hookdeck: [
    "Hookdeck relays deliveries from another provider: the event is the original provider's payload, and Hookdeck signs what it forwards with the project's signing secret.",
    "These settings are in the Hookdeck dashboard; tell the user each step. The Hookdeck CLI and API can also create connections.",
    "1. Create a connection whose destination is an HTTP destination with the webhook URL. Keep the destination's authentication on Hookdeck Signature (the default, `auth_type: HOOKDECK_SIGNATURE` in the API); Hookdeck only signs with it set.",
    "2. Read the signing secret from Settings > Secrets (https://dashboard.hookdeck.com/settings/project/secrets) and store it as the endpoint's signing secret. It is one secret for the whole project.",
    "The signature headers are always `x-hookdeck-signature` and `x-hookdeck-signature-2`. If the project's header prefix was changed in the project settings, the event id arrives as `<prefix>-eventid` instead of `x-hookdeck-eventid`: pass the prefix as `webhooks.hookdeck({ headerPrefix })` so retries dedupe on it.",
    "When the secret is rolled in Hookdeck with a delay, deliveries keep verifying through the old secret until the new one is stored here.",
    "Subscribers' filters compare fields of the original provider's payload, for example `event.type` for a Stripe source.",
  ].join("\n"),
};

export * from "../schemas/webhookConfig.js";
