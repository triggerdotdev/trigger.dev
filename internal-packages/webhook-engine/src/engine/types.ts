import type { Logger } from "@trigger.dev/core/logger";
import type { WebhookResponseConfig } from "@trigger.dev/core/v3";
import type { Meter, Tracer } from "@internal/tracing";
import type { WebhookDatabase } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";

export type WebhookDeliverTaskErrorType = "QUEUE_LIMIT" | "SYSTEM_ERROR" | "NOT_FOUND";

export type TriggerWebhookTaskParams = {
  environmentId: string;
  taskId: string;
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
    concurrency: number;
    workers?: number;
    tasksPerWorker?: number;
    pollIntervalMs?: number;
    shutdownTimeoutMs?: number;
    disabled?: boolean;
  };
  partitions?: {
    ensureSchedule?: string;
    ensureJitterInMs?: number;
    lookaheadDays?: number; // 7..14; how many days ahead to pre-create
    retentionDays?: number; // keep this many days back; drop colder children
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
}

export type DeliverWebhookToSessionParams = {
  environmentId: string;
  taskIdentifier: string; // the claiming agent; the session's task
  externalId: string; // resolved from the routing target's keyTemplate
  deliverAs: "action" | "message"; // "action" -> onAction envelope; "message" -> a channel turn
  actionType?: string; // becomes the action envelope's `type` (deliverAs "action")
  connectorId?: string; // the channel connector id (deliverAs "message"); the run resolves inbound by it
  event: unknown; // delivery.parsedEvent
  source: string; // provider tag
  headers: Record<string, string>;
  deliveryId: string; // externalDeliveryId; also the S2 part id for idempotent re-append
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
  | { outcome: "unsupported_target" }; // routing target isn't a task

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
