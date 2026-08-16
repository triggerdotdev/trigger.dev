import { Webhook, resourceCatalog } from "@trigger.dev/core/v3";
import type {
  WebhookSource,
  InferWebhookEvent,
  AnyWebhookSource,
  WebhookRunPayload,
  ValidateWebhookFilter,
  ChatEvent,
  ValidatedWebhookKey,
  WebhookVerifierConfig,
  StripeWebhookEvent,
  GitHubWebhookEvent,
  TaskRunContext,
} from "@trigger.dev/core/v3";
import { subtle } from "../imports/uncrypto.js";
import { createTask, type Task } from "./shared.js";
import {
  discordVerifierConfig,
  githubVerifierConfig,
  squareVerifierConfig,
  stripeVerifierConfig,
  svixVerifierConfig,
  webhookProviderConfigs,
  type WebhookProviderId,
} from "@trigger.dev/core/webhooks";

/**
 * The type of error thrown when a webhook fails to parse or verify
 */
export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

/** Header name used for webhook signatures */
const SIGNATURE_HEADER_NAME = "x-trigger-signature-hmacsha256";

/**
 * Options for constructing a webhook event
 */
type ConstructEventOptions = {
  /** Raw payload as string or Buffer */
  payload: string | Buffer;
  /** Signature header as string, Buffer, or string array */
  header: string | Buffer | Array<string>;
};

// ── Source producers (presets carry the event type) ──
export const webhookSources = {
  custom<T = unknown>(config: WebhookVerifierConfig): WebhookSource<T> {
    // Roll-your-own webhooks: you control both ends, so offer paste AND generate.
    return {
      provider: "custom",
      verifier: { kind: "config", config },
      secretProvisioning: "either",
    };
  },

  // Stripe: `Stripe-Signature: t=…,v1=…` (comma-kv), signed `{t}.{body}`, hex.
  // Defaults to a minimal event shape; pass the official type for full typing: stripe<Stripe.Event>().
  stripe<TEvent = StripeWebhookEvent>(opts?: { toleranceSeconds?: number }): WebhookSource<TEvent> {
    return {
      provider: "stripe",
      verifier: { kind: "preset", preset: "stripe", config: stripeVerifierConfig(opts) },
      secretProvisioning: "provider",
    };
  },

  // GitHub: `X-Hub-Signature-256: sha256=<hex>` (prefixed), signed raw body.
  // Defaults to an open shape; pass your event type for full typing: github<MyPushEvent>().
  github<TEvent = GitHubWebhookEvent>(): WebhookSource<TEvent> {
    return {
      provider: "github",
      verifier: { kind: "preset", preset: "github", config: githubVerifierConfig() },
      secretProvisioning: "integrator",
    };
  },

  // Svix family (Svix, Clerk, Resend): `svix-signature: v1,<b64> v1,<b64>` (space-list),
  // signed `{id}.{timestamp}.{body}`, base64; the `whsec_` secret is base64-decoded.
  svix<T = unknown>(): WebhookSource<T> {
    return {
      provider: "svix",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  // Square: bare base64 signature over `{notificationURL}{body}` (URL template var, no separator).
  square<T = unknown>(): WebhookSource<T> {
    return {
      provider: "square",
      verifier: { kind: "preset", preset: "square", config: squareVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  // Discord: asymmetric Ed25519 over `{timestamp}{body}`. The "secret" stored on the endpoint is
  // the application PUBLIC KEY (hex by default). No shared secret.
  discord<T = unknown>(opts: { publicKeyEncoding?: "raw-hex" | "pem" } = {}): WebhookSource<T> {
    return {
      provider: "discord",
      verifier: { kind: "preset", preset: "discord", config: discordVerifierConfig(opts) },
      secretProvisioning: "provider",
    };
  },

  /**
   * Per-provider producers over shared presets. Each is a thin wrapper: same verifier config as the
   * preset it references, differing only in `provider` (routing + picker identity) and who provisions
   * the secret. Pass the provider's own published type for full typing, e.g. clerk<WebhookEvent>().
   */
  clerk<T = unknown>(): WebhookSource<T> {
    return {
      provider: "clerk",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  resend<T = unknown>(): WebhookSource<T> {
    return {
      provider: "resend",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  openai<T = unknown>(): WebhookSource<T> {
    return {
      provider: "openai",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  replicate<T = unknown>(): WebhookSource<T> {
    return {
      provider: "replicate",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  recallai<T = unknown>(): WebhookSource<T> {
    return {
      provider: "recall-ai",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  brex<T = unknown>(): WebhookSource<T> {
    return {
      provider: "brex",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  gitlab<T = unknown>(): WebhookSource<T> {
    return {
      provider: "gitlab",
      verifier: {
        kind: "config",
        config: { scheme: "shared-secret", placement: "header", fieldName: "x-gitlab-token" },
      },
      secretProvisioning: "integrator",
    };
  },

  whatsapp<T = unknown>(): WebhookSource<T> {
    return {
      provider: "whatsapp",
      verifier: { kind: "preset", preset: "github", config: githubVerifierConfig() },
      secretProvisioning: "integrator",
    };
  },
} as const;

/**
 * Per-provider producers generated from the core config table (kind "config"). Each carries the
 * provider's own HMAC verifier config and stays in lockstep with the round-trip-tested configs.
 */
export type ProviderProducers = {
  [K in WebhookProviderId]: <TEvent = unknown>() => WebhookSource<TEvent>;
};

export const providerProducers = Object.fromEntries(
  Object.entries(webhookProviderConfigs).map(([provider, entry]) => [
    provider,
    () => ({
      provider,
      verifier: { kind: "config" as const, config: entry.config() },
      secretProvisioning: entry.secretProvisioning,
    }),
  ])
) as ProviderProducers;

// ── webhook() entry: single-callback IoC, infers event from source ──
export type WebhookOnEventParams<TEvent> = {
  /** The verified event body, typed by the source (a preset type, or the `<T>` you supply). */
  event: TEvent;
  /** The inbound request headers (case-insensitive, Web `Headers`). e.g. headers.get("x-github-event"). */
  headers: Headers;
  ctx: TaskRunContext;
};

export type WebhookOptions<TIdentifier extends string, TSource extends AnyWebhookSource> = {
  id: TIdentifier;
  source: TSource;
  /**
   * Optional server-side filter (a type-safe string DSL checked against the event shape). A delivery
   * that doesn't match is received and recorded but not routed (no run). e.g.
   * `"event.action == 'created' && event.repository.private == false"`.
   */
  filter?: string;
  onEvent: (params: WebhookOnEventParams<InferWebhookEvent<TSource>>) => Promise<void> | void;
};

export type WebhookHandle<TIdentifier extends string, TEvent> = Task<TIdentifier, TEvent, void>;

export function webhook<
  TIdentifier extends string,
  TSource extends AnyWebhookSource,
  const TFilter extends string = string,
>(
  options: WebhookOptions<TIdentifier, TSource> & {
    filter?: TFilter & ValidateWebhookFilter<InferWebhookEvent<TSource>, TFilter>;
  }
): WebhookHandle<TIdentifier, InferWebhookEvent<TSource>> {
  const { id, source, onEvent, filter } = options;

  // 1. The task half: webhook IS a first-class task kind (triggerSource "webhook").
  // The platform delivers a { event, headers } envelope; unwrap it for onEvent. The handle's
  // payload type stays the event (webhook tasks are triggered by the ingress, not tasks.trigger).
  const task = createTask<TIdentifier, InferWebhookEvent<TSource>, void>({
    id,
    triggerSource: "webhook",
    run: async (payload, runOptions) => {
      const envelope = payload as unknown as WebhookRunPayload<InferWebhookEvent<TSource>>;
      await onEvent({
        event: envelope.event,
        headers: new Headers(envelope.headers ?? {}),
        ctx: runOptions.ctx,
      });
    },
  });

  // 2. The endpoint half: register the verifier + default routing target (this task) + filter.
  resourceCatalog.registerWebhookMetadata({
    id,
    source: source.provider,
    verifierArtifact: source.verifier,
    routingTarget: { type: "task", taskId: id },
    secretProvisioning: source.secretProvisioning,
    filter,
  });

  return task;
}

// ── chat.event(): declarative descriptor an agent claims via chat.agent({ events }). No handler. ──
// Carries the verifier (source), a validated string `key`, and a `type` discriminant. The `key`
// validates against the event/webhook/header namespaces and mirrors the stored {body.x} wire template.
export function chatEvent<
  TSource extends AnyWebhookSource,
  const TId extends string = string,
  const TKey extends string = string,
  const TType extends string = TId,
  const TFilter extends string = string,
>(options: {
  id: TId;
  source: TSource;
  key: ValidatedWebhookKey<InferWebhookEvent<TSource>, TKey>;
  /** The `action.type` the handler reads. Optional; defaults to `id`. */
  type?: TType;
  /** Optional server-side filter (same type-safe DSL as `webhook()`); a non-match is recorded FILTERED and not routed. */
  filter?: TFilter & ValidateWebhookFilter<InferWebhookEvent<TSource>, TFilter>;
}): ChatEvent<TType, InferWebhookEvent<TSource>> {
  const { id, source, key, type, filter } = options;
  const keyTemplate = normalizeKeyString(key as string);

  // Record the descriptor as declared so the indexer can flag it if no agent ever claims it.
  resourceCatalog.registerDeclaredSessionWebhook(id);

  return {
    id,
    type: type ?? id,
    key: keyTemplate,
    source: source.provider,
    verifierArtifact: source.verifier,
    secretProvisioning: source.secretProvisioning,
    filter,
  } as ChatEvent<TType, InferWebhookEvent<TSource>>;
}

// Public chat-event types (descriptor, the shared action union, and the key namespaces).
export type {
  ChatEvent,
  AnyChatEvent,
  ChatEventAction,
  ChatEventActions,
  WebhookKeyMeta,
} from "@trigger.dev/core/v3";

// Brace placeholders without a recognized namespace default to the event body. webhook./header./body.
// pass through unchanged.
export function normalizeKeyString(key: string): string {
  const namespaceAlternative = (alternative: string): string => {
    const trimmed = alternative.trim();
    return trimmed.startsWith("webhook.") ||
      trimmed.startsWith("header.") ||
      trimmed.startsWith("body.")
      ? trimmed
      : `body.${trimmed}`;
  };
  return key.replace(
    /\{([^{}]+)\}/g,
    (_match, path: string) => `{${path.split("||").map(namespaceAlternative).join(" || ")}}`
  );
}

// P2 seam (TYPE only):
export type { CreateWebhookEndpointParams } from "@trigger.dev/core/v3";

/**
 * Interface describing the webhook utilities
 */
interface Webhooks {
  /**
   * Constructs and validates a webhook event from an incoming request
   * @param request - Either a Request object or ConstructEventOptions containing the payload and signature
   * @param secret - Secret key used to verify the webhook signature
   * @returns Promise resolving to a validated AlertWebhook object
   * @throws {WebhookError} If validation fails or payload can't be parsed
   *
   * @example
   * // Using with Request object
   * const event = await webhooks.constructEvent(request, "webhook_secret");
   *
   * @example
   * // Using with manual options
   * const event = await webhooks.constructEvent({
   *   payload: rawBody,
   *   header: signatureHeader
   * }, "webhook_secret");
   */
  constructEvent(request: ConstructEventOptions | Request, secret: string): Promise<Webhook>;

  /** Header name used for webhook signatures */
  SIGNATURE_HEADER_NAME: string;
  custom: typeof webhookSources.custom;
  stripe: typeof webhookSources.stripe;
  github: typeof webhookSources.github;
  svix: typeof webhookSources.svix;
  square: typeof webhookSources.square;
  discord: typeof webhookSources.discord;
  clerk: typeof webhookSources.clerk;
  resend: typeof webhookSources.resend;
  openai: typeof webhookSources.openai;
  replicate: typeof webhookSources.replicate;
  recallai: typeof webhookSources.recallai;
  brex: typeof webhookSources.brex;
  gitlab: typeof webhookSources.gitlab;
  whatsapp: typeof webhookSources.whatsapp;
}

/**
 * Webhook utilities for handling incoming webhook requests
 */
export const webhooks: Webhooks & ProviderProducers = {
  ...providerProducers,
  constructEvent,
  SIGNATURE_HEADER_NAME,
  custom: webhookSources.custom,
  stripe: webhookSources.stripe,
  github: webhookSources.github,
  svix: webhookSources.svix,
  square: webhookSources.square,
  discord: webhookSources.discord,
  clerk: webhookSources.clerk,
  resend: webhookSources.resend,
  openai: webhookSources.openai,
  replicate: webhookSources.replicate,
  recallai: webhookSources.recallai,
  brex: webhookSources.brex,
  gitlab: webhookSources.gitlab,
  whatsapp: webhookSources.whatsapp,
};

async function constructEvent(
  request: ConstructEventOptions | Request,
  secret: string
): Promise<Webhook> {
  let payload: string;
  let signature: string;

  if (request instanceof Request) {
    if (!secret) {
      throw new WebhookError("Secret is required when passing a Request object");
    }

    const signatureHeader = request.headers.get(SIGNATURE_HEADER_NAME);
    if (!signatureHeader) {
      throw new WebhookError("No signature header found");
    }
    signature = signatureHeader;

    payload = await request.text();
  } else {
    payload = request.payload.toString();

    if (Array.isArray(request.header)) {
      throw new WebhookError("Signature header cannot be an array");
    }
    signature = request.header.toString();
  }

  // Verify the signature
  const isValid = await verifySignature(payload, signature, secret);

  if (!isValid) {
    throw new WebhookError("Invalid signature");
  }

  // Parse and validate the payload
  try {
    const jsonPayload = JSON.parse(payload);
    const parsedPayload = Webhook.parse(jsonPayload);
    return parsedPayload;
  } catch (error) {
    if (error instanceof Error) {
      throw new WebhookError(`Webhook parsing failed: ${error.message}`);
    }
    throw new WebhookError("Webhook parsing failed");
  }
}

/**
 * Verifies the signature of a webhook payload
 * @param payload - Raw payload string to verify
 * @param signature - Expected signature to check against
 * @param secret - Secret key used to generate the signature
 * @returns Promise resolving to boolean indicating if signature is valid
 * @throws {WebhookError} If signature verification process fails
 *
 * @example
 * const isValid = await verifySignature(
 *   '{"event": "test"}',
 *   "abc123signature",
 *   "webhook_secret"
 * );
 */
async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    if (!secret) {
      throw new WebhookError("Secret is required for signature verification");
    }

    // Convert the payload and secret to buffers
    const hashPayload = Buffer.from(payload, "utf-8");
    const hmacSecret = Buffer.from(secret, "utf-8");

    // Import the secret key
    const key = await subtle.importKey(
      "raw",
      hmacSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    // Calculate the expected signature
    const actualSignature = await subtle.sign("HMAC", key, hashPayload);
    const actualSignatureHex = Buffer.from(actualSignature).toString("hex");

    // Compare signatures using timing-safe comparison
    return timingSafeEqual(signature, actualSignatureHex);
  } catch (_error) {
    throw new WebhookError("Signature verification failed");
  }
}

// Timing-safe comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
