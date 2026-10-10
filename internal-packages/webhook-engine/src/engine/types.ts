import type { Logger } from "@trigger.dev/core/logger";
import type { WebhookEndpointContext, WebhookResponseConfig } from "@trigger.dev/core/v3";
import type { Meter, Tracer } from "@internal/tracing";
import type { WebhookDatabase } from "@trigger.dev/database";
import type { RedisClusterClientOptions, RedisOptions } from "@internal/redis";

export type WebhookDeliverTaskErrorType = "QUEUE_LIMIT" | "SYSTEM_ERROR" | "NOT_FOUND";

export type TriggerWebhookTaskParams = {
  environmentId: string;
  taskId: string;
  /** The routing target this trigger is for. */
  targetId: string;
  /** The delivery's friendly id, recorded on the run so it links back to the delivery. */
  deliveryId: string;
  /** The endpoint the delivery arrived on; rides on the run payload. */
  endpoint: WebhookEndpointContext;
  idempotencyKey: string; // = externalDeliveryId; the Run Engine correctness gate
  idempotencyKeyExpiresAt: Date; // provider retry window
  payload: unknown; // delivery.parsedEvent, already JSON
  headers: Record<string, string>; // inbound request headers -> onEvent({ headers })
  identityTags: string[]; // endpoint identity -> run tags
  endpointMetadata: unknown; // endpoint.metadata -> run metadata
};

export type TriggerWebhookTaskCallback = (params: TriggerWebhookTaskParams) => Promise<{
  success: boolean;
  runId?: string; // persisted onto WebhookDelivery.runId on success
  error?: string;
  errorType?: WebhookDeliverTaskErrorType;
}>;

export interface WebhookEngineOptions {
  logger?: Logger;
  logLevel?: string;
  prisma: WebhookDatabase;
  /** Direct owner connection for partition DDL. Defaults to prisma when not configured. */
  partitionPrisma?: WebhookDatabase;
  redis: RedisOptions;
  /**
   * When true the feature is fully off: the engine skips opening its Redis clients and building the
   * worker, so a deployment with webhooks disabled holds no connections and does no queue polling.
   * Distinct from `worker.disabled`, which keeps the engine (and its front-gate Redis) for ingress
   * but does not start the worker loop.
   */
  disabled?: boolean;
  worker: {
    /** Webhook jobs this process runs at once. */
    concurrency: number;
    /**
     * Webhook jobs one environment can have in flight at once, across every process: a number, or a
     * lookup for per-org limits. Default 100.
     */
    tenantConcurrency?: number | ((environmentId: string) => Promise<number>);
    pollIntervalMs?: number;
    shutdownTimeoutMs?: number;
    disabled?: boolean;
    /** How long a job's exhausted record waits to retry when the exhausted handler failed. Default 30s. */
    exhaustedRecordDelayMs?: number;
  };
  partitions?: {
    ensureSchedule?: string;
    ensureJitterInMs?: number;
    lookaheadDays?: number; // 7..14; how many days ahead to pre-create
  };
  /** Which retention class new deliveries are stamped with. */
  retention?: {
    /** The org's delivery retention in days, for an environment. Rounded up to a class. */
    forEnvironment?: (environmentId: string) => Promise<number>;
    /** Used when there's no lookup or it fails. Default 30. */
    defaultDays?: number;
  };
  tracer?: Tracer;
  meter?: Meter;
  frontGate?: { defaultTtlSeconds?: number; maxTtlSeconds?: number; claimTtlSeconds?: number };
  // Hot-path cache for the endpoint + resolved signing secret, keyed by opaqueId. ttlMs <= 0 disables.
  endpointCache?: { ttlMs?: number; maxSize?: number };
  triggerTask: TriggerWebhookTaskCallback;
  // Q4: injected so the engine never imports the webapp SecretStore. Returns the
  // plaintext signing secret, or undefined/empty so ingest fails closed.
  resolveSigningSecret: (key: string) => Promise<string | undefined>;
  /**
   * The verify token a provider's GET URL verification must present (Meta's `hub.verify_token`),
   * by endpoint id. Separate from the signing secret and generated in the dashboard; undefined
   * or empty means no GET verification is possible yet and the handshake is refused.
   */
  resolveVerifyToken?: (endpointId: string) => Promise<string | undefined>;
  // Session routing: find-or-create the session on the resolved key and append the action envelope.
  deliverToSession?: DeliverWebhookToSessionCallback;
  /** Webhook waiters. Without `waitpoints`, waiter create/cancel are refused and deliveries skip the waiter step. */
  waiters?: WebhookWaiterOptions;
}

type WebhookWaiterOptions = {
  /**
   * The waiter store (also the ingest front gate). A cluster when `cluster` is set, otherwise a
   * standalone node from `redis`, falling back to the engine's `redis`.
   */
  redis?: RedisOptions;
  cluster?: RedisClusterClientOptions;
  limits?: Partial<WebhookWaiterLimits>;
  /** Signs URL-matched waiter paths so waiter ids can't be enumerated through the ingress. */
  urlSecret?: string;
  waitpoints?: WebhookWaitpointPorts;
  /** Waiters one job resumes. A delivery that claims more splits the rest into completion jobs. Default 500. */
  completionChunkSize?: number;
};

export type WebhookWaiterLimits = {
  perEnvironment: number;
  perEndpoint: number;
  shapes: number;
  paths: number;
  tags: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
};

/** What a matched waiter's run resumes with: one packet per delivery, shared by every waiter it completes. */
export type WebhookWaiterOutput = {
  event: unknown;
  headers: Record<string, string>;
  deliveryId: string;
  endpoint: WebhookEndpointContext;
};

/** MANUAL waitpoints backing waiters. A waiter's id is its waitpoint's friendly id. */
export type WebhookWaitpointPorts = {
  find(params: {
    environmentId: string;
    idempotencyKey: string;
  }): Promise<
    { id: string; status: "PENDING" | "COMPLETED"; timeoutAt?: Date; tags?: string[] } | undefined
  >;
  create(params: {
    environmentId: string;
    projectId: string;
    idempotencyKey: string;
    idempotencyKeyExpiresAt?: Date;
    timeoutAt: Date;
    tags: string[];
  }): Promise<{ id: string; isCached: boolean }>;
  /** Complete every id with the same output, built and stored once. */
  complete(params: {
    environmentId: string;
    waitpointIds: string[];
    output: WebhookWaiterOutput;
    deliveryFriendlyId: string;
  }): Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  fail(params: {
    environmentId: string;
    waitpointId: string;
    error: { name: string; message: string; reason?: string };
  }): Promise<void>;
};

type WebhookWaiterLimitReason =
  | "environment_limit"
  | "endpoint_limit"
  | "shape_limit"
  | "timeout_too_long";

export type CreateWebhookWaiterInput = {
  environmentId: string;
  projectId: string;
  /** The declared endpoint id (`webhooks.endpoint.define`), or the endpoint's `wh_` id. */
  endpoint: string;
  match?: Record<string, string | number | boolean>;
  /** Limits for this create's org, over the engine defaults (per-plan waiter caps). */
  limits?: { perEnvironment?: number; perEndpoint?: number };
  filter?: string;
  /** Absent: the default timeout. */
  timeoutAt?: Date;
  tags?: string[];
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
};

export type CreateWebhookWaiterResult =
  | {
      outcome: "created";
      id: string;
      /** Path of the waiter's own ingress URL, for a URL-matched waiter. */
      urlPath?: string;
      expiresAt: Date;
      isCached: boolean;
    }
  | { outcome: "endpoint_not_found" }
  | { outcome: "limit"; reason: WebhookWaiterLimitReason; message: string }
  | { outcome: "invalid"; error: string }
  | { outcome: "filter_invalid"; error: string };

export type CancelWebhookWaiterResult =
  | { outcome: "cancelled" }
  | { outcome: "too_late"; deliveryId: string }
  | { outcome: "not_found" };

/** A live waiter as the dashboard lists it. `match` and `filter` are what it was created with. */
export type ListedWebhookWaiter = {
  id: string;
  expiresAt: Date;
  match?: Record<string, string | number | boolean>;
  filter?: string;
};

export type DeliverWebhookToSessionParams = {
  environmentId: string;
  taskIdentifier: string; // the claiming agent; the session's task
  /** The routing target this delivery is for. */
  targetId: string;
  /**
   * The `.in` part id to claim and append under: unique per delivery row and target, so two targets
   * resolving to one session each append, a deliver retry re-claims the same id, and a replay appends anew.
   */
  partId: string;
  /** The endpoint the delivery arrived on; rides on the action and channel envelopes. */
  endpoint: WebhookEndpointContext;
  externalId: string; // resolved from the routing target's keyTemplate
  deliverAs: "action" | "message"; // "action" -> onAction envelope; "message" -> a channel turn
  actionType?: string; // becomes the action envelope's `type` (deliverAs "action")
  connectorId?: string; // the channel connector id (deliverAs "message"); the run resolves inbound by it
  event: unknown; // delivery.parsedEvent
  source: string; // provider tag
  headers: Record<string, string>;
  /** The delivery's friendly id (`whd_`): new on a replay, the same across retries of one delivery. */
  deliveryId: string;
  /** The provider's id for the delivery (e.g. Stripe's `evt_`), the same across replays. */
  externalDeliveryId: string;
  triggerConfigTemplate?: Record<string, unknown>;
  idempotencyKey: string;
  // Evaluated startOn: true (default) allows creating a new session; false means resume-only, so a
  // key with no existing session is ignored rather than started.
  isSessionStart: boolean;
};

export type DeliverWebhookToSessionCallback = (params: DeliverWebhookToSessionParams) => Promise<{
  success: boolean;
  runId?: string; // the session's current run, persisted onto WebhookDelivery.runId
  error?: string;
  errorType?: WebhookDeliverTaskErrorType;
  skipped?: boolean; // resume-only and no session existed: recorded FILTERED, not routed
  skippedReason?: string;
}>;

export type IngestInput = {
  opaqueId: string; // Q2: globally unique, so ingest resolves the endpoint (and its env id + type) from it
  rawBytes: Uint8Array;
  headers: Record<string, string>;
  url: string;
};

export type ReplayResult =
  | { outcome: "replayed"; deliveryId: string; deliveryFriendlyId: string } // new row + run enqueued
  | { outcome: "delivery_not_found" }
  | { outcome: "endpoint_not_found" }
  | { outcome: "target_not_found" }
  /** `authorize` refused some of the subscribers the replay would run; nothing was created. */
  | { outcome: "forbidden"; denied: string[] };

/** A subscriber a replay would run: a webhook() task, or a session subscriber and its agent task. */
export type ReplaySubscriber = { id: string; type: "task" | "session"; taskId: string };

export type ReplayInput = {
  id: string;
  createdAt: Date;
  /** Replay only this target, past its filter. Omitted: every current target, filters re-checked. */
  targetId?: string;
  /**
   * Called with exactly the subscribers the replay would run (after filters), from the same read
   * that creates it. Returns what the caller may not trigger; any entry refuses the replay.
   */
  authorize?: (subscribers: ReplaySubscriber[]) => string[] | Promise<string[]>;
};

/** The endpoint's declared response contract, when its verifier artifact carries one. */
type IngestResponseContract = WebhookResponseConfig | undefined;

/**
 * Outcomes of `ingest()`. The HTTP answer is the caller's: `accepted` and `duplicate` default to 200
 * JSON, `verification_failed` and `secret_missing` to 400, unless `response` declares otherwise.
 * A `handshake` carries its own status and text body and records no delivery; other failures map to
 * 404, 405 or 500.
 */
export type IngestResult =
  | {
      outcome: "accepted";
      deliveryId: string;
      deliveryFriendlyId: string;
      response?: IngestResponseContract;
    }
  | { outcome: "handshake"; body: string; status: 200 | 204; response?: IngestResponseContract }
  | { outcome: "duplicate"; deliveryId?: string; response?: IngestResponseContract }
  | { outcome: "endpoint_not_found" }
  | { outcome: "endpoint_inactive" }
  | { outcome: "secret_missing"; response?: IngestResponseContract }
  | { outcome: "verification_failed"; error: string; response?: IngestResponseContract }
  | { outcome: "method_not_allowed"; allowedMethods?: ("GET" | "HEAD" | "POST")[] }
  | { outcome: "enqueue_failed"; error: string };

/** A provider's GET verification request: the endpoint's opaque id and the decoded query string. */
export type GetHandshakeInput = {
  opaqueId: string;
  query: Record<string, string>;
};
