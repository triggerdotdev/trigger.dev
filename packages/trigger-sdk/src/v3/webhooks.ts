import { Webhook, resourceCatalog } from "@trigger.dev/core/v3";
import type {
  WebhookSource,
  InferWebhookEvent,
  AnyWebhookSource,
  ValidateWebhookFilter,
  NarrowWebhookEvent,
  ChatEvent,
  ValidatedWebhookKey,
  WebhookResponseConfig,
  WebhookUrlSecretConfig,
  WebhookVerifierConfig,
  StripeWebhookEvent,
  GitHubWebhookEvent,
  TaskRunContext,
  AnyWebhookEndpoint,
  InferWebhookEndpointEvent,
  WebhookEndpoint,
  WebhookEndpointContext,
  TaskOptions,
} from "@trigger.dev/core/v3";
import { subtle } from "../imports/uncrypto.js";
import {
  cancelWebhookWaiter,
  createWebhookWaiter,
  waitForWebhookWaiter,
} from "./webhookWaiters.js";
import { createTask, type Task } from "./shared.js";
import {
  discordVerifierConfig,
  githubVerifierConfig,
  squareVerifierConfig,
  standardWebhooksVerifierConfig,
  stripeVerifierConfig,
  svixVerifierConfig,
  webhookProviderConfigs,
  webhookSetupPrompts,
  type HookdeckSourceOptions,
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

/**
 * The verifier configs a hosted endpoint can enforce. A `url-secret` placed in the path is excluded:
 * the hosted ingress URL is fixed per endpoint, so there is no path segment for the caller to choose,
 * and the server refuses such a declaration at deploy time. Use `placement: "query"` instead.
 */
export type HostedWebhookVerifierConfig =
  | Exclude<WebhookVerifierConfig, WebhookUrlSecretConfig>
  | (Omit<WebhookUrlSecretConfig, "placement"> & { placement: "query" });

// ── Source producers (presets carry the event type) ──
export const webhookSources = {
  custom<T = unknown>(
    config: HostedWebhookVerifierConfig,
    options?: {
      /** Instructions for an AI agent registering an endpoint on this source with the provider. */
      setupPrompt?: string;
      /**
       * How the endpoint answers the provider. `{ acceptedBody: "empty" }` acknowledges with an empty
       * 200, for providers that show the response to a user (Slack slash commands).
       */
      response?: WebhookResponseConfig;
    }
  ): WebhookSource<T> {
    if (config.scheme === "url-secret" && (config as WebhookUrlSecretConfig).placement === "path") {
      throw new Error(
        'webhooks.custom(): url-secret verification cannot use placement "path" on the hosted ingress URL. Use placement "query" or a header-based scheme.'
      );
    }
    // Roll-your-own webhooks: you control both ends, so offer paste AND generate.
    return {
      provider: "custom",
      verifier: {
        kind: "config",
        config,
        ...(options?.response ? { response: options.response } : {}),
      },
      secretProvisioning: "either",
      ...(options?.setupPrompt ? { setupPrompt: options.setupPrompt } : {}),
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
  // signed `{id}.{timestamp}.{body}`, base64; the `whsec_` secret is base64-decoded. Providers that
  // send the spec's `webhook-*` header names instead use `standardWebhooks()`.
  svix<T = unknown>(): WebhookSource<T> {
    return {
      provider: "svix",
      verifier: { kind: "preset", preset: "svix", config: svixVerifierConfig() },
      secretProvisioning: "provider",
    };
  },

  // Standard Webhooks (Composio, and any provider implementing the spec directly): the Svix scheme under
  // the spec's `webhook-id` / `webhook-timestamp` / `webhook-signature` header names.
  standardWebhooks<T = unknown>(): WebhookSource<T> {
    return {
      provider: "standard-webhooks",
      verifier: {
        kind: "preset",
        preset: "standard-webhooks",
        config: standardWebhooksVerifierConfig(),
      },
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

  /**
   * Discord: asymmetric Ed25519 over `{timestamp}{body}`. The "secret" stored on the endpoint is the
   * application PUBLIC KEY (hex by default); there is no shared secret. Discord's response contract
   * is declared as data on the artifact: the `{ type: 0 }` PING sent when the URL is saved is answered
   * with a bodiless 204 and never recorded, accepted events are acknowledged with 204, and a bad
   * signature gets 401.
   */
  discord<T = unknown>(opts: { publicKeyEncoding?: "raw-hex" | "pem" } = {}): WebhookSource<T> {
    return {
      provider: "discord",
      verifier: {
        kind: "preset",
        preset: "discord",
        config: discordVerifierConfig(opts),
        handshake: { matchPath: "type", matchValue: "0", respondStatus: 204 },
        response: { acceptedStatus: 204, rejectedStatus: 401 },
      },
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
      verifier: {
        kind: "preset",
        preset: "standard-webhooks",
        config: standardWebhooksVerifierConfig(),
      },
      secretProvisioning: "provider",
    };
  },

  replicate<T = unknown>(): WebhookSource<T> {
    return {
      provider: "replicate",
      verifier: {
        kind: "preset",
        preset: "standard-webhooks",
        config: standardWebhooksVerifierConfig(),
      },
      secretProvisioning: "provider",
    };
  },

  recallai<T = unknown>(): WebhookSource<T> {
    return {
      provider: "recall-ai",
      verifier: {
        kind: "preset",
        preset: "standard-webhooks",
        config: standardWebhooksVerifierConfig(),
      },
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

  composio<T = unknown>(): WebhookSource<T> {
    return {
      provider: "composio",
      verifier: {
        kind: "preset",
        preset: "standard-webhooks",
        config: standardWebhooksVerifierConfig(),
      },
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

  /**
   * WhatsApp Cloud API (Meta): `X-Hub-Signature-256` HMAC over the raw body, keyed by the App Secret,
   * which Meta issues and you paste in as the endpoint's signing secret (it cannot be generated here).
   * Meta verifies the callback URL with a GET carrying `hub.mode`, `hub.verify_token` and
   * `hub.challenge`; the endpoint answers it when the token equals the verify token generated in
   * the endpoint's Connect panel, which you paste into Meta's Verify Token field.
   */
  whatsapp<T = unknown>(): WebhookSource<T> {
    return {
      provider: "whatsapp",
      verifier: {
        kind: "preset",
        preset: "github",
        config: githubVerifierConfig(),
        getHandshake: {
          matchParam: "hub.mode",
          matchValue: "subscribe",
          tokenParam: "hub.verify_token",
          challengeParam: "hub.challenge",
        },
      },
      secretProvisioning: "provider",
    };
  },

  /**
   * Hookdeck relays deliveries from another provider, so `T` is the original provider's event. It
   * verifies `x-hookdeck-signature` (and `x-hookdeck-signature-2` while a secret is being rolled)
   * with the Hookdeck project's signing secret, and dedupes retries on `x-hookdeck-eventid`. Pass
   * `headerPrefix` when the project's header prefix was changed from `x-hookdeck`.
   */
  hookdeck<T = unknown>(options?: HookdeckSourceOptions): WebhookSource<T> {
    const setupPrompt = webhookSetupPrompts.hookdeck;
    return {
      provider: "hookdeck",
      verifier: { kind: "config", config: webhookProviderConfigs.hookdeck.config(options) },
      secretProvisioning: webhookProviderConfigs.hookdeck.secretProvisioning,
      ...(setupPrompt ? { setupPrompt } : {}),
    };
  },
} as const;

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

/**
 * Per-provider producers generated from the core config table (kind "config"). Each carries the
 * provider's own HMAC verifier config and stays in lockstep with the round-trip-tested configs.
 * The method is the provider id in camel case (`cal-com` is `webhooks.calCom()`); the emitted
 * `provider` keeps the id itself.
 */
export type ProviderProducers = {
  [K in Exclude<WebhookProviderId, "zoom"> as CamelCase<K>]: <
    TEvent = unknown,
  >() => WebhookSource<TEvent>;
};

function producerName(provider: string): string {
  return provider.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export const providerProducers = Object.fromEntries(
  Object.entries(webhookProviderConfigs)
    // Zoom needs a computed URL-validation response that the hosted ingress does not support yet.
    .filter(([provider]) => provider !== "slack" && provider !== "zoom" && provider !== "hookdeck")
    .map(([provider, entry]) => [
      producerName(provider),
      () => {
        const setupPrompt = webhookSetupPrompts[provider as WebhookProviderId];
        return {
          provider,
          verifier: { kind: "config" as const, config: entry.config() },
          secretProvisioning: entry.secretProvisioning,
          ...(setupPrompt ? { setupPrompt } : {}),
        };
      },
    ])
) as Omit<ProviderProducers, "slack" | "hookdeck">;

// ── webhooks.endpoint.define(): one provider URL that subscribers and waiters attach to ──
export type WebhookEndpointOptions<TIdentifier extends string, TSource extends AnyWebhookSource> = {
  /** The endpoint id. Subscribers reference the endpoint, and it names the endpoint's URL. */
  id: TIdentifier;
  /** The provider source: how deliveries are verified and who issues the signing secret. */
  source: TSource;
  description?: string;
  /** Arbitrary metadata, passed to every subscriber and waiter as `endpoint.metadata`. */
  metadata?: Record<string, unknown>;
};

/**
 * Declare a webhook endpoint: one URL you register with the provider. Subscribe to it with
 * `webhook({ endpoint })`, `chat.event({ endpoint })` or a channel connector, and wait on it with
 * `webhooks.waiter.create(endpoint, ...)`. An endpoint with no subscribers still gets a URL.
 */
export function defineWebhookEndpoint<TIdentifier extends string, TSource extends AnyWebhookSource>(
  options: WebhookEndpointOptions<TIdentifier, TSource>
): WebhookEndpoint<InferWebhookEvent<TSource>> & { id: TIdentifier } {
  const { id, source, description, metadata } = options;
  if (id.startsWith("wh_")) {
    throw new Error(
      `webhooks.endpoint.define("${id}"): an endpoint id can't start with "wh_"; that prefix is reserved for generated endpoint ids.`
    );
  }
  const setupPrompt =
    source.setupPrompt ??
    (source.verifier.kind === "preset"
      ? webhookSetupPrompts[source.verifier.preset as keyof typeof webhookSetupPrompts]
      : undefined);

  resourceCatalog.registerWebhookEndpointMetadata({
    id,
    source: source.provider,
    verifierArtifact: source.verifier,
    ...(description ? { description } : {}),
    ...(source.secretProvisioning ? { secretProvisioning: source.secretProvisioning } : {}),
    ...(setupPrompt ? { setupPrompt } : {}),
    ...(metadata ? { metadata } : {}),
  });

  return { id, source: source.provider } as WebhookEndpoint<InferWebhookEvent<TSource>> & {
    id: TIdentifier;
  };
}

// ── webhook(): a task subscriber on an endpoint ──
export type WebhookOnEventParams<TEvent> = {
  /** The verified event body, typed by the endpoint's source. */
  event: TEvent;
  /** The inbound request headers (case-insensitive, Web `Headers`). e.g. headers.get("x-github-event"). */
  headers: Headers;
  /** The endpoint the delivery arrived on. Unset when the task is triggered by hand without one. */
  endpoint?: WebhookEndpointContext;
  ctx: TaskRunContext;
};

/**
 * The `task()` options a webhook task also takes: `queue`, `concurrency`, `machine`, `retry`,
 * `maxDuration`, `ttl` and the lifecycle hooks. e.g. `queue: { concurrencyLimit: 1 }` handles one
 * delivery at a time.
 */
export type WebhookTaskOptions<TIdentifier extends string, TEvent> = Omit<
  TaskOptions<TIdentifier, WebhookTaskPayload<TEvent>, void>,
  "id" | "run" | "jsonSchema" | "triggerSource" | "agentConfig"
>;

export type WebhookOptions<
  TIdentifier extends string,
  TEndpoint extends AnyWebhookEndpoint,
  TEvent = InferWebhookEndpointEvent<TEndpoint>,
> = WebhookTaskOptions<TIdentifier, TEvent> & {
  id: TIdentifier;
  /** The endpoint this task subscribes to. */
  endpoint: TEndpoint;
  /**
   * Optional server-side filter (a type-safe string DSL checked against the event shape). A delivery
   * this subscriber's filter rejects is still recorded, and other subscribers on the endpoint still
   * get it. e.g. `"event.action == 'created' && event.repository.private == false"`.
   */
  filter?: string;
  /** Gets the event narrowed by the filter's `event.<field> == '<value>'` clauses. */
  onEvent: (params: WebhookOnEventParams<TEvent>) => Promise<void> | void;
};

/**
 * What a webhook task runs on: the verified event, the delivery headers and the endpoint. The hosted
 * ingress sends it for every delivery; triggering the handle by hand (`myWebhook.trigger({ event })`,
 * a replay, a test) sends the same shape, so `onEvent` sees the event either way.
 */
export type WebhookTaskPayload<TEvent> = {
  event: TEvent;
  headers?: Record<string, string>;
  endpoint?: WebhookEndpointContext;
};

export type WebhookHandle<TIdentifier extends string, TEvent> = Task<
  TIdentifier,
  WebhookTaskPayload<TEvent>,
  void
>;

export function webhook<
  TIdentifier extends string,
  TEndpoint extends AnyWebhookEndpoint,
  const TFilter extends string = string,
>(
  options: WebhookOptions<
    TIdentifier,
    TEndpoint,
    NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>
  > & {
    filter?: ValidateWebhookFilter<InferWebhookEndpointEvent<TEndpoint>, TFilter>;
  }
): WebhookHandle<TIdentifier, NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>> {
  const { id, endpoint, onEvent, filter, ...taskOptions } = options;
  if (!endpoint?.id) {
    throw new Error(
      `webhook("${id}"): an endpoint is required. Declare one with webhooks.endpoint.define() and pass it as { endpoint }.`
    );
  }

  const task = createTask<
    TIdentifier,
    WebhookTaskPayload<NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>>,
    void
  >({
    ...taskOptions,
    id,
    triggerSource: "webhook",
    run: async (payload, runOptions) => {
      await onEvent({
        event: payload.event,
        headers: new Headers(payload.headers ?? {}),
        endpoint: payload.endpoint,
        ctx: runOptions.ctx,
      });
    },
  });

  resourceCatalog.registerWebhookSubscriber({
    endpointId: endpoint.id,
    target: { type: "task", id, taskId: id, ...(filter ? { filter } : {}) },
  });

  return task;
}

// ── chat.event(): a session subscriber an agent claims via chat.agent({ events }). No handler. ──
// Carries the endpoint, a validated string `key`, and a `type` discriminant. The `key` validates
// against the event/header/webhook namespaces, like a filter path, and compiles to the stored
// {body.x} wire template.
export function chatEvent<
  TEndpoint extends AnyWebhookEndpoint,
  const TId extends string = string,
  const TKey extends string = string,
  const TType extends string = TId,
  const TFilter extends string = string,
>(options: {
  id: TId;
  /** The endpoint this event subscribes to. */
  endpoint: TEndpoint;
  /**
   * The session each delivery goes to, as a template: `{event.x}` reads the event, `{header.x}` a
   * header and `{webhook.x}` the endpoint, and `{a || b}` falls back to `b` when `a` is empty. e.g.
   * `"{webhook.externalRef}:{event.data.object.customer}"`.
   */
  key: ValidatedWebhookKey<NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>, TKey>;
  /** The `action.type` the handler reads. Optional; defaults to `id`. */
  type?: TType;
  /**
   * Optional server-side filter (same type-safe DSL as `webhook()`); a non-match is recorded FILTERED
   * and not routed. Narrows the action's `event` like `webhook()`'s `onEvent`.
   */
  filter?: ValidateWebhookFilter<InferWebhookEndpointEvent<TEndpoint>, TFilter>;
}): ChatEvent<TType, NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>> {
  const { id, endpoint, key, type, filter } = options;
  if (!endpoint?.id) {
    throw new Error(
      `chat.event("${id}"): an endpoint is required. Declare one with webhooks.endpoint.define() and pass it as { endpoint }.`
    );
  }

  // Record the descriptor as declared so the indexer can flag it if no agent ever claims it.
  resourceCatalog.registerDeclaredSessionWebhook(id);

  return {
    id,
    type: type ?? id,
    key: normalizeKeyString(key as string),
    endpointId: endpoint.id,
    source: endpoint.source,
    filter,
  } as ChatEvent<TType, NarrowWebhookEvent<InferWebhookEndpointEvent<TEndpoint>, TFilter>>;
}

// Public chat-event types (descriptor, the shared action union, and the key namespaces).
export type {
  ChatEvent,
  AnyChatEvent,
  ChatEventAction,
  ChatEventActions,
  WebhookKeyMeta,
} from "@trigger.dev/core/v3";

/**
 * Compiles a key template to its stored form. Each placeholder names its namespace the way a filter
 * path does: `{event.x}` reads the event body (stored as `{body.x}`), `{header.x}` a header and
 * `{webhook.x}` the endpoint. A placeholder without one of those namespaces throws.
 */
export function normalizeKeyString(key: string): string {
  const namespaceAlternative = (alternative: string): string => {
    const trimmed = alternative.trim();
    if (trimmed.startsWith("event.")) return `body.${trimmed.slice("event.".length)}`;
    if (trimmed.startsWith("webhook.") || trimmed.startsWith("header.")) return trimmed;
    const path = trimmed.startsWith("body.") ? trimmed.slice("body.".length) : trimmed;
    throw new Error(
      `Invalid key "${key}": "{${trimmed}}" needs a namespace. Use {event.${path}} for the event body, {header.<name>} or {webhook.<field>}.`
    );
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
  standardWebhooks: typeof webhookSources.standardWebhooks;
  square: typeof webhookSources.square;
  discord: typeof webhookSources.discord;
  clerk: typeof webhookSources.clerk;
  resend: typeof webhookSources.resend;
  openai: typeof webhookSources.openai;
  replicate: typeof webhookSources.replicate;
  recallai: typeof webhookSources.recallai;
  brex: typeof webhookSources.brex;
  composio: typeof webhookSources.composio;
  gitlab: typeof webhookSources.gitlab;
  whatsapp: typeof webhookSources.whatsapp;
  hookdeck: typeof webhookSources.hookdeck;
  /** Declare the URLs providers deliver to. */
  endpoint: { define: typeof defineWebhookEndpoint };
  /** Suspend a run until a matching webhook arrives. */
  waiter: {
    create: typeof createWebhookWaiter;
    wait: typeof waitForWebhookWaiter;
    cancel: typeof cancelWebhookWaiter;
  };
}

/**
 * Webhook utilities for handling incoming webhook requests
 */
export const webhooks: Webhooks & Omit<ProviderProducers, "slack" | "hookdeck"> = {
  ...providerProducers,
  constructEvent,
  SIGNATURE_HEADER_NAME,
  custom: webhookSources.custom,
  stripe: webhookSources.stripe,
  github: webhookSources.github,
  svix: webhookSources.svix,
  standardWebhooks: webhookSources.standardWebhooks,
  square: webhookSources.square,
  discord: webhookSources.discord,
  clerk: webhookSources.clerk,
  resend: webhookSources.resend,
  openai: webhookSources.openai,
  replicate: webhookSources.replicate,
  recallai: webhookSources.recallai,
  brex: webhookSources.brex,
  composio: webhookSources.composio,
  gitlab: webhookSources.gitlab,
  whatsapp: webhookSources.whatsapp,
  hookdeck: webhookSources.hookdeck,
  endpoint: { define: defineWebhookEndpoint },
  waiter: { create: createWebhookWaiter, wait: waitForWebhookWaiter, cancel: cancelWebhookWaiter },
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
