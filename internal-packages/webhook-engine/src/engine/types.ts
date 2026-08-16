import type { Logger } from "@trigger.dev/core/logger";
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

export interface TriggerWebhookTaskCallback {
  (params: TriggerWebhookTaskParams): Promise<{
    success: boolean;
    runId?: string; // persisted onto WebhookDelivery.runId on success
    error?: string;
    errorType?: WebhookDeliverTaskErrorType;
  }>;
}

export interface WebhookEngineOptions {
  logger?: Logger;
  logLevel?: string;
  prisma: WebhookDatabase;
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

export interface DeliverWebhookToSessionCallback {
  (params: DeliverWebhookToSessionParams): Promise<{
    success: boolean;
    runId?: string; // the session's current run, persisted onto WebhookDelivery.runId
    error?: string;
    errorType?: WebhookDeliverTaskErrorType;
    skipped?: boolean; // resume-only and no session existed: recorded FILTERED, not routed
    skippedReason?: string;
  }>;
}

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

export type IngestResult =
  | { outcome: "accepted"; deliveryId: string; deliveryFriendlyId: string }
  | { outcome: "handshake"; body: string } // provider handshake (Slack url_verification) -> 200 echo
  | { outcome: "duplicate"; deliveryId?: string } // front-gate hit -> 200
  | { outcome: "endpoint_not_found" } // -> 404
  | { outcome: "endpoint_inactive" } // -> 404
  | { outcome: "secret_missing" } // -> 400 (fail-closed)
  | { outcome: "verification_failed"; error: string } // -> 400
  | { outcome: "enqueue_failed"; error: string }; // -> 5xx (provider retries)
