import type { Counter, Histogram, Meter, ObservableGauge, Tracer } from "@internal/tracing";
import { getMeter, getTracer, startSpan } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import type {
  Prisma,
  WebhookDatabase,
  WebhookReplicaDatabase,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from "@trigger.dev/database";
import {
  createFairQueueRedisClient,
  isClusterConnection,
  keyPrefixOf,
  TenantQueueFullError,
} from "@trigger.dev/redis-worker";
import { WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import type {
  FilterAst,
  WebhookDeliveryTargetResult,
  WebhookEndpointContext,
  WebhookRoutingTarget,
} from "@trigger.dev/core/v3";
import {
  WebhookDeliveryId,
  isWebhookEndpointFriendlyId,
  webhookDeliveryRetentionClassAtLeast,
} from "@trigger.dev/core/v3/isomorphic";
import {
  type CompleteWaitersJobPayload,
  type DeliverJobPayload,
  type DeliveryRecord,
  WEBHOOK_JOB_MAX_ATTEMPTS,
  type WebhookJob,
  WebhookJobQueue,
} from "./jobQueue.js";
import { isInfrastructureError, WebhookInfrastructureError } from "./errors.js";
import { QueueMemoryGuard } from "./memoryGuard.js";
import { ensurePartitions, listDatedPartitions, partitionsCoveredUntil } from "./partitions.js";
import { evaluateFilter, parseFilter } from "./filter/index.js";
import { verifyWithSecrets } from "./verification/index.js";
import { sha256Hex } from "./verification/util.js";
import { deriveIdempotencyKey, parseEventBody } from "./verification/derive.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CancelWebhookWaiterResult,
  ListedWebhookWaiter,
  CreateWebhookWaiterInput,
  CreateWebhookWaiterResult,
  GetHandshakeInput,
  IngestInput,
  IngestResult,
  ReplayInput,
  ReplaySubscriber,
  ReplayResult,
  WebhookWaiterLimits,
  TriggerWebhookTaskCallback,
  WebhookDeliverTaskErrorType,
  WebhookEngineMetricsHooks,
  WebhookMetricsEnvironment,
  WebhookEngineOptions,
  WebhookRedisOptions,
} from "./types.js";
import {
  displaySessionKeyTemplate,
  evaluateSessionKeyTemplate,
  walkPath as resolveBodyPath,
} from "./sessionKey.js";
import {
  endpointContext,
  type ParsedRoutingTarget,
  parseDeliveryTargets,
  parseRoutingTargets,
  summarizeFilterReasons,
} from "./targets.js";
import {
  type ClaimCounts,
  WebhookWaiterStore,
  type WaiterCandidateGroup,
} from "./waiters/store.js";
import { eventValues, validateMatch, valuesHash, waiterShape } from "./waiters/match.js";

const DEFAULT_WAITER_COMPLETION_CHUNK = 500;

const TERMINAL_DELIVERY_STATUSES = new Set(["SUCCEEDED", "FAILED", "FILTERED", "UNMATCHED"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Waiter idempotency keys live in the environment's waitpoint key space, so they get their own
 * prefix: a waiter's key can never find a token some other caller created.
 */
const WAITER_IDEMPOTENCY_PREFIX = "webhook-waiter:";

const DEFAULT_WAITER_LIMITS: WebhookWaiterLimits = {
  perEnvironment: 1_000_000,
  perEndpoint: 10_000,
  shapes: 25,
  paths: 5,
  tags: 10,
  defaultTimeoutMs: DAY_MS,
  maxTimeoutMs: 90 * DAY_MS,
};

/** What the waiter step produced on one deliver attempt. */
type WaiterStepResult = {
  /** The delivery's one waiter entry, absent when it claimed no waiters. */
  summary?: WebhookDeliveryTargetResult;
  hadLiveWaiters: boolean;
  /** Completion jobs are still resuming claimed waiters; the last to finish settles the delivery. */
  deferred: boolean;
  /** The step failed on our infrastructure, so the delivery retries however many attempts it took. */
  infrastructure?: boolean;
};

/** What routing one target produced on one deliver attempt. */
type TargetOutcome =
  | { kind: "succeeded"; runId?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "transient"; error?: string; infrastructure?: boolean }
  | { kind: "failed"; error: string };

type TaskTarget = Extract<WebhookRoutingTarget, { type: "task" }>;
type SessionTarget = Extract<WebhookRoutingTarget, { type: "session" }>;

/** An ACTIVE endpoint with its signing secrets (current first) and parsed routing targets. */
type ResolvedEndpoint = {
  endpoint: WebhookEndpoint;
  secrets: [string, ...string[]];
  targets: ParsedRoutingTarget[];
};

/** The response contract declared on a verifier artifact, if any (bundles carry none). */
function artifactResponseContract(artifact: WebhookVerifierArtifact) {
  return "response" in artifact ? artifact.response : undefined;
}

/** The same Redis connection with its key prefix replaced (or removed, with `undefined`). */
function withKeyPrefix(
  redis: WebhookRedisOptions,
  keyPrefix: string | undefined
): WebhookRedisOptions {
  if (isClusterConnection(redis)) {
    return {
      cluster: {
        ...redis.cluster,
        clusterOptions: { ...redis.cluster.clusterOptions, keyPrefix },
        redisOptions: { ...redis.cluster.redisOptions, keyPrefix: undefined },
      },
    };
  }
  return { ...redis, keyPrefix };
}

/**
 * A delivery's full partition key, for a unique-key update. Every row carries its class, so this
 * prunes to one leaf.
 */
function primaryKey(delivery: Pick<WebhookDelivery, "id" | "createdAt" | "retentionDays">) {
  return { id: delivery.id, createdAt: delivery.createdAt, retentionDays: delivery.retentionDays };
}

/**
 * Find one delivery by id, pruned by the class and mint time its id encodes. A v1 id (minted before
 * classes) carries no class, so it prunes only by `createdAt` within each class.
 */
function deliveryKey(id: string, createdAt?: Date) {
  const retentionDays = WebhookDeliveryId.parseRetentionDays(id);
  return {
    id,
    ...(createdAt ? { createdAt } : {}),
    ...(retentionDays !== undefined ? { retentionDays } : {}),
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type RecordAndRouteArgs = {
  endpoint: WebhookEndpoint;
  artifact: WebhookVerifierArtifact;
  targets: ParsedRoutingTarget[];
  parsedEvent: unknown;
  idempotencyKey: string;
  errorMessage: string | null;
  rawBytes: Uint8Array;
  headers: Record<string, string>;
  waiterId?: string;
};

/** How long a session append claim outlives its delivery: longer than any delivery is retried. */
const SESSION_PART_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long one attempt holds a session append claim before another may take it over. */
const SESSION_PART_LEASE_MS = 60_000;

export class WebhookEngine {
  private jobQueue!: WebhookJobQueue;
  private memoryGuard?: QueueMemoryGuard;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;

  private deliveryEnqueueCounter: Counter;
  private deliveryFilteredCounter: Counter;
  private deliveryExecutionCounter: Counter;
  private deliveryExecutionDuration: Histogram;
  private deliveryExecutionFailureCounter: Counter;
  private ensurePartitionsCounter: Counter;
  private ingestCounter: Counter;
  private ingestRefusedCounter: Counter;
  private frontGateRequeuedCounter: Counter;
  private deliverySettleLatency: Histogram;
  private targetResultCounter: Counter;
  private waitersCreatedCounter: Counter;
  private waiterClaimSize: Histogram;
  private waitersResolvedCounter: Counter;
  private partitionsAhead: ObservableGauge;
  /** When the first retention class runs out of leaves, refreshed hourly by every running worker. */
  private partitionsCoveredUntil?: Date;
  private partitionCoverageTimer?: NodeJS.Timeout;

  prisma: WebhookDatabase;
  private readonly replica: WebhookReplicaDatabase;

  private triggerTask: TriggerWebhookTaskCallback;
  private waiterStore!: WebhookWaiterStore;
  private readonly waiterLimits: WebhookWaiterLimits;

  constructor(private readonly options: WebhookEngineOptions) {
    this.logger =
      options.logger ?? new Logger("WebhookEngine", (this.options.logLevel ?? "info") as any);
    this.prisma = options.prisma;
    this.replica = options.replica ?? options.prisma;
    this.triggerTask = options.triggerTask;
    this.waiterLimits = { ...DEFAULT_WAITER_LIMITS, ...options.waiters?.limits };

    this.tracer = options.tracer ?? getTracer("webhook-engine");
    this.meter = options.meter ?? getMeter("webhook-engine");

    this.deliveryEnqueueCounter = this.meter.createCounter("webhook_delivery_enqueues_total", {
      description: "Total number of webhook deliveries enqueued for routing",
    });
    this.deliveryFilteredCounter = this.meter.createCounter("webhook_delivery_filtered_total", {
      description:
        "Total number of webhook deliveries received but routed to no target because every target filter rejected them",
    });
    this.deliveryExecutionCounter = this.meter.createCounter("webhook_delivery_executions_total", {
      description: "Total number of webhook delivery routing executions",
    });
    this.deliveryExecutionDuration = this.meter.createHistogram(
      "webhook_delivery_execution_duration_ms",
      { description: "Duration of webhook delivery routing in milliseconds", unit: "ms" }
    );
    this.deliveryExecutionFailureCounter = this.meter.createCounter(
      "webhook_delivery_execution_failures_total",
      { description: "Total number of webhook delivery routing failures" }
    );
    this.ensurePartitionsCounter = this.meter.createCounter("webhook_ensure_partitions_total", {
      description: "Total number of ensurePartitions cron runs",
    });
    this.ingestCounter = this.meter.createCounter("webhook_ingest_total", {
      description:
        "Webhook requests received, by path (endpoint or a waiter's own URL) and outcome (accepted, duplicate, verification_failed, ...)",
    });
    this.ingestRefusedCounter = this.meter.createCounter("webhook_ingest_refused_total", {
      description:
        "Webhook deliveries ingest refused with a retryable answer, by reason (queue_full, high_water, enqueue_failed)",
    });
    this.frontGateRequeuedCounter = this.meter.createCounter("webhook_front_gate_requeued_total", {
      description:
        "Provider retries that found their delivery claimed but not yet queued, and queued it",
    });
    this.deliverySettleLatency = this.meter.createHistogram("webhook_delivery_settle_latency_ms", {
      description:
        "Time from a delivery arriving to its final status, by status (SUCCEEDED, FAILED, FILTERED, UNMATCHED)",
      unit: "ms",
    });
    this.targetResultCounter = this.meter.createCounter("webhook_delivery_target_results_total", {
      description: "Final per-target results of settled deliveries, by target type and status",
    });
    this.waitersCreatedCounter = this.meter.createCounter("webhook_waiters_created_total", {
      description:
        "Webhook waiter create calls, by outcome (created, cached, limit, invalid, filter_invalid, endpoint_not_found)",
    });
    this.waiterClaimSize = this.meter.createHistogram("webhook_waiter_claim_size", {
      description: "Waiters one delivery claimed, by whether the resume was split into chunk jobs",
    });
    this.waitersResolvedCounter = this.meter.createCounter("webhook_waiters_resolved_total", {
      description:
        "Claimed waiters settled, by result (resumed, or failed after their last attempt)",
    });
    this.partitionsAhead = this.meter.createObservableGauge("webhook_partitions_ahead_days", {
      description:
        "Days of future delivery partitions left, read hourly by each running worker. Ingest fails once it reaches 0.",
    });
    this.partitionsAhead.addCallback((result) => {
      if (!this.partitionsCoveredUntil) return;
      result.observe((this.partitionsCoveredUntil.getTime() - Date.now()) / DAY_MS);
    });

    if (options.disabled) {
      this.logger.info("Webhook engine disabled; skipping Redis and worker setup");
      return;
    }

    const keyPrefix = keyPrefixOf(options.redis);
    const storeRedis = createFairQueueRedisClient(withKeyPrefix(options.redis, undefined));
    this.waiterStore = new WebhookWaiterStore(storeRedis, keyPrefix, this.waiterLimits);
    this.memoryGuard = new QueueMemoryGuard(storeRedis, {
      highWater: options.queue?.highWater ?? 0.75,
      intervalMs: options.queue?.memoryCheckIntervalMs ?? 5_000,
      logger: this.logger,
    });
    this.memoryGuard.start();

    this.jobQueue = new WebhookJobQueue({
      redis: withKeyPrefix(options.redis, `${keyPrefix}webhook:`),
      logger: new Logger("WebhookJobQueue", (options.logLevel ?? "info") as any),
      tracer: options.tracer,
      meter: options.meter,
      consumers: options.worker.concurrency,
      tenantConcurrency: options.worker.tenantConcurrency ?? 100,
      consumerIntervalMs: Math.min(options.worker.pollIntervalMs ?? 100, 100),
      exhaustedRecordDelayMs: options.worker.exhaustedRecordDelayMs,
      retryBaseDelayMs: options.worker.retryBaseDelayMs,
      environmentPayloadBytesLimit: options.queue?.environmentPayloadBytesLimit,
      onProcessing: options.metrics?.onProcessing
        ? (environmentId, inFlight, limit) =>
            this.#metric((hooks) => hooks.onProcessing?.({ environmentId }, inFlight, limit))
        : undefined,
      handlers: {
        deliver: this.#handleDeliverJob.bind(this),
        completeWaiters: this.#handleCompleteWaitersJob.bind(this),
        exhausted: this.#handleExhaustedJob.bind(this),
      },
    });

    if (!options.worker.disabled) {
      this.jobQueue.start();
      const refreshCoverage = () =>
        this.#refreshPartitionCoverage().catch((error: unknown) =>
          this.logger.warn("Couldn't read webhook delivery partitions", {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      void refreshCoverage();
      this.partitionCoverageTimer = setInterval(refreshCoverage, 60 * 60 * 1000);
      this.partitionCoverageTimer.unref();
      this.logger.info("Webhook engine worker started", {
        concurrency: options.worker.concurrency,
        pollIntervalMs: options.worker.pollIntervalMs,
      });
    } else {
      this.logger.info("Webhook engine worker disabled");
    }
  }

  #assertEnabled(): void {
    if (this.options.disabled) {
      throw new Error('WebhookEngine is disabled: WEBHOOK_ENABLED is not "1"');
    }
  }

  // PUBLIC ENTRY: verify inline, append-only delivery write, enqueue routing, ack.
  async ingest(input: IngestInput): Promise<IngestResult> {
    this.#assertEnabled();
    return this.#countIngest("endpoint", this.#ingest(input));
  }

  async #countIngest(path: "endpoint" | "waiter", pending: Promise<IngestResult>) {
    try {
      const result = await pending;
      this.ingestCounter.add(1, { path, outcome: result.outcome });
      return result;
    } catch (error) {
      this.ingestCounter.add(1, { path, outcome: "error" });
      throw error;
    }
  }

  async #ingest(input: IngestInput): Promise<IngestResult> {
    return startSpan(this.tracer, "webhook.ingest", async (span) => {
      span.setAttribute("opaqueId", input.opaqueId);

      const resolved = await this.#resolveEndpoint(input.opaqueId);
      if (!resolved.ok) return resolved.result;
      const { endpoint, secrets } = resolved;

      // 3. Verify inline. safeParse the Json artifact so a corrupt row is a 400, not a 5xx storm.
      const parsedArtifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      if (!parsedArtifact.success) {
        return { outcome: "verification_failed", error: "corrupt verifier artifact" };
      }
      const response = artifactResponseContract(parsedArtifact.data);
      const verdict = verifyWithSecrets(
        parsedArtifact.data,
        { rawBytes: input.rawBytes, headers: input.headers, url: input.url },
        secrets
      );
      if (verdict.secretIndex) span.setAttribute("webhook.previous_secret", true);
      if (!verdict.ok) {
        return { outcome: "verification_failed", error: verdict.error ?? "invalid", response };
      }

      // Provider handshake (Slack url_verification, Discord PING): a signed request that must get a
      // synchronous echo, not a recorded/routed delivery. Generic, declared on the verifier artifact.
      const handshake =
        "handshake" in parsedArtifact.data ? parsedArtifact.data.handshake : undefined;
      if (handshake) {
        const event = verdict.parsedEvent as unknown;
        if (String(resolveBodyPath(event, handshake.matchPath) ?? "") === handshake.matchValue) {
          return {
            outcome: "handshake",
            status: handshake.respondStatus ?? 200,
            body: handshake.respondPath
              ? String(resolveBodyPath(event, handshake.respondPath) ?? "")
              : "",
            response,
          };
        }
      }

      return this.#recordAndRoute({
        endpoint,
        artifact: parsedArtifact.data,
        targets: resolved.targets,
        parsedEvent: verdict.parsedEvent,
        idempotencyKey: verdict.idempotencyKey,
        errorMessage: verdict.error ?? null,
        rawBytes: input.rawBytes,
        headers: input.headers,
      });
    });
  }

  /**
   * Shared post-verify path for ingest() and simulateInject(): the memory high-water check, the
   * front gate (dedupe), the filter gate, and one durable enqueue of a deliver job carrying the
   * whole delivery. Nothing here writes Postgres: the job writes the delivery row before it routes,
   * so an acknowledged delivery always has a job, and a crash before the enqueue leaves nothing.
   *
   * The front gate claims the idempotency key for the whole dedupe window, holding the new
   * delivery's id, and is promoted once the job is queued. A retry that finds the key only claimed
   * (the first attempt died before queueing it, or is still queueing it) queues the same delivery
   * again under the same id: the queue ignores an id it already holds, and a job that already ran
   * finds its row settled. A provider retry never loses the event and never makes a second delivery.
   * With `waiterId` (a delivery to a URL-matched waiter's own URL) there is no fan-out: the delivery
   * can complete only that waiter.
   */
  async #recordAndRoute(args: RecordAndRouteArgs): Promise<IngestResult> {
    const { endpoint, artifact, idempotencyKey, waiterId } = args;
    const response = artifactResponseContract(artifact);
    const environmentId = endpoint.runtimeEnvironmentId;

    const gateKey = waiterId ? `w:${waiterId}:${idempotencyKey}` : idempotencyKey;

    if (this.memoryGuard?.isFull(this.jobQueue.slotForEnvironment(environmentId))) {
      const existing = await this.waiterStore
        .peekFrontGate(endpoint.id, gateKey)
        .catch(() => undefined);
      if (existing?.promoted) {
        return { outcome: "duplicate", deliveryId: existing.deliveryFriendlyId, response };
      }
      this.#refuse("high_water", environmentId);
      return { outcome: "over_capacity" };
    }

    const minted = WebhookDeliveryId.generate({
      retentionDays: await this.#retentionDays(environmentId),
    });

    let gate: Awaited<ReturnType<WebhookWaiterStore["claimFrontGate"]>>;
    try {
      gate = await this.waiterStore.claimFrontGate(
        endpoint.id,
        gateKey,
        minted.friendlyId,
        this.#frontGateTtlSeconds(artifact)
      );
    } catch (error) {
      this.#refuse("enqueue_failed", environmentId, error);
      return { outcome: "enqueue_failed", error: String(error) };
    }

    if (gate.claimed) {
      return this.#queueDelivery(args, {
        delivery: {
          id: minted.id,
          friendlyId: minted.friendlyId,
          createdAt: minted.timestamp,
          retentionDays: minted.retentionDays,
        },
        arrivedAt: gate.arrivedAt,
        hasLiveWaiters: gate.hasLiveWaiters,
        gateKey,
      });
    }

    const existing = gate.existing;
    const claimedAt =
      existing && !existing.promoted
        ? WebhookDeliveryId.parseTimestamp(existing.deliveryFriendlyId)
        : undefined;
    const claimedRetention = existing
      ? WebhookDeliveryId.parseRetentionDays(existing.deliveryFriendlyId)
      : undefined;
    if (!existing || !claimedAt || claimedRetention === undefined) {
      return { outcome: "duplicate", deliveryId: existing?.deliveryFriendlyId, response };
    }

    const requeued = await this.#queueDelivery(args, {
      delivery: {
        id: WebhookDeliveryId.toId(existing.deliveryFriendlyId),
        friendlyId: existing.deliveryFriendlyId,
        createdAt: claimedAt,
        retentionDays: claimedRetention,
      },
      arrivedAt: claimedAt.getTime(),
      hasLiveWaiters: waiterId
        ? false
        : await this.waiterStore.hasLiveWaiters(endpoint.id, claimedAt.getTime()),
      gateKey,
    });
    if (requeued.outcome !== "accepted") return requeued;
    this.frontGateRequeuedCounter.add(1);
    return { outcome: "duplicate", deliveryId: existing.deliveryFriendlyId, response };
  }

  /**
   * Queue the deliver job for a claimed delivery and promote its front gate. Leaves the claim in
   * place when the job can't be queued, so the provider's retry queues it.
   */
  async #queueDelivery(
    args: RecordAndRouteArgs,
    claim: {
      delivery: { id: string; friendlyId: string; createdAt: Date; retentionDays: number };
      arrivedAt: number;
      hasLiveWaiters: boolean;
      gateKey: string;
    }
  ): Promise<IngestResult> {
    const { endpoint, artifact, targets, parsedEvent, idempotencyKey, errorMessage, headers } =
      args;
    const { waiterId } = args;
    const { delivery, arrivedAt, hasLiveWaiters, gateKey } = claim;

    const secretHeader =
      "config" in artifact &&
      artifact.config.scheme === "shared-secret" &&
      artifact.config.placement === "header"
        ? artifact.config.fieldName
        : undefined;

    const targetResults = waiterId
      ? []
      : this.#evaluateTargets(targets, parsedEvent, headers, endpoint, idempotencyKey);
    const filtered =
      !waiterId && !hasLiveWaiters && !targetResults.some((result) => result.status === "PENDING");

    const record: DeliveryRecord = {
      friendlyId: delivery.friendlyId,
      retentionDays: delivery.retentionDays,
      webhookEndpointId: endpoint.id,
      organizationId: endpoint.organizationId,
      projectId: endpoint.projectId,
      runtimeEnvironmentId: endpoint.runtimeEnvironmentId,
      environmentType: endpoint.environmentType,
      externalDeliveryId: idempotencyKey,
      idempotencyKey,
      status: filtered ? "FILTERED" : "PENDING",
      isTest: Object.entries(headers).some(
        ([key, value]) => key.toLowerCase() === "x-trigger-test" && Boolean(value)
      ),
      parsedEvent: toStorableEvent(parsedEvent),
      headers: capHeaders(
        headers,
        secretHeader,
        hasLiveWaiters && !waiterId
          ? await this.#waiterHeaderNames(endpoint.id, arrivedAt)
          : undefined
      ),
      rawBodyHash: sha256Hex(args.rawBytes),
      errorMessage,
      filterReason: filtered ? summarizeFilterReasons(targetResults) : null,
      targets: targetResults,
    };

    const queued = await this.#enqueueDeliverJob(endpoint.runtimeEnvironmentId, endpoint.id, {
      deliveryId: delivery.id,
      createdAt: delivery.createdAt,
      arrivedAt,
      liveWaiters: hasLiveWaiters,
      ...(waiterId ? { waiterId } : {}),
      record,
    });
    if (queued) return queued;

    if (filtered) this.deliveryFilteredCounter.add(1);
    else this.deliveryEnqueueCounter.add(1);

    await this.waiterStore
      .promoteFrontGate(endpoint.id, gateKey, delivery.friendlyId)
      .catch(() => {});

    return {
      outcome: "accepted",
      deliveryId: delivery.id,
      deliveryFriendlyId: delivery.friendlyId,
      response: artifactResponseContract(artifact),
    };
  }

  /** Count a retryable ingest refusal by reason, and log which environment it was for. */
  #refuse(
    reason: "high_water" | "queue_full" | "enqueue_failed",
    environmentId: string,
    error?: unknown
  ) {
    this.ingestRefusedCounter.add(1, { reason });
    this.logger.warn("webhook ingest refused a delivery for the provider to retry", {
      reason,
      environmentId,
      ...(error !== undefined
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    });
  }

  /** Queue a deliver job. Returns the refusal to answer with, or undefined once it is queued. */
  async #enqueueDeliverJob(
    environmentId: string,
    endpointId: string,
    payload: DeliverJobPayload
  ): Promise<Extract<IngestResult, { outcome: "queue_full" | "enqueue_failed" }> | undefined> {
    try {
      await this.jobQueue.enqueue({
        id: `webhook-delivery:${payload.deliveryId}`,
        environmentId,
        endpointId,
        job: { job: "webhook.deliver", payload },
      });
      return undefined;
    } catch (error) {
      if (error instanceof TenantQueueFullError) {
        this.#refuse("queue_full", environmentId);
        return { outcome: "queue_full" };
      }
      this.#refuse("enqueue_failed", environmentId, error);
      return { outcome: "enqueue_failed", error: String(error) };
    }
  }

  /** Reject unsupported methods without resolving credentials or recording a delivery. */
  async rejectUnsupportedMethod(opaqueId: string): Promise<IngestResult> {
    this.#assertEnabled();
    return startSpan(this.tracer, "webhook.unsupportedMethod", async (span) => {
      span.setAttribute("opaqueId", opaqueId);
      const endpoint = await this.replica.webhookEndpoint.findFirst({
        where: { opaqueId },
        select: { status: true, verifierArtifact: true },
      });
      if (!endpoint) return { outcome: "endpoint_not_found" };
      if (endpoint.status !== "ACTIVE") return { outcome: "endpoint_inactive" };

      const artifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      const supportsGet =
        artifact.success && "getHandshake" in artifact.data && !!artifact.data.getHandshake;
      return {
        outcome: "method_not_allowed",
        // Remix serves HEAD through the GET loader, stripping the response body.
        allowedMethods: supportsGet ? ["GET", "HEAD", "POST"] : ["POST"],
      };
    });
  }

  /**
   * Answer a provider's GET verification of the endpoint URL (Meta's `hub.challenge` flow) without
   * recording a delivery. The artifact's `getHandshake` names the query parameters: the token must
   * equal the endpoint's verify token (a dedicated credential, resolved through the injected port,
   * not the signing secret) and the challenge is echoed as text. The endpoint only has to exist and
   * be active; the signing secret is a separate credential for POST deliveries and may not be set
   * yet when the provider verifies the URL. An endpoint whose artifact declares no GET handshake
   * answers `method_not_allowed`, as before.
   */
  async verifyGetHandshake(input: GetHandshakeInput): Promise<IngestResult> {
    this.#assertEnabled();
    return startSpan(this.tracer, "webhook.getHandshake", async (span) => {
      span.setAttribute("opaqueId", input.opaqueId);

      const endpoint = await this.replica.webhookEndpoint.findFirst({
        where: { opaqueId: input.opaqueId },
      });
      if (!endpoint) return { outcome: "endpoint_not_found" };
      if (endpoint.status !== "ACTIVE") return { outcome: "endpoint_inactive" };

      const parsedArtifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      if (!parsedArtifact.success) {
        return { outcome: "verification_failed", error: "corrupt verifier artifact" };
      }
      const getHandshake =
        "getHandshake" in parsedArtifact.data ? parsedArtifact.data.getHandshake : undefined;
      if (!getHandshake) return { outcome: "method_not_allowed" };

      const response = artifactResponseContract(parsedArtifact.data);
      if (
        getHandshake.matchParam &&
        input.query[getHandshake.matchParam] !== getHandshake.matchValue
      ) {
        return { outcome: "verification_failed", error: "handshake mode mismatch", response };
      }
      const expected = await this.options.resolveVerifyToken?.(endpoint.id);
      if (!expected) {
        return { outcome: "verification_failed", error: "verify token not set", response };
      }
      const token = input.query[getHandshake.tokenParam];
      if (!token || !constantTimeEqual(token, expected)) {
        return { outcome: "verification_failed", error: "handshake token mismatch", response };
      }
      const challenge = input.query[getHandshake.challengeParam];
      if (challenge === undefined) {
        return { outcome: "verification_failed", error: "handshake challenge missing", response };
      }
      return { outcome: "handshake", status: 200, body: challenge, response };
    });
  }

  /**
   * Inject a delivery WITHOUT signature verification, then run the same filter + record + route path
   * as ingest(). This is the test-console "simulate" mode for endpoints we cannot sign for
   * (asymmetric public-key schemes; url-secret path placement). The body must be JSON, or a form
   * sent with a form-encoded content type. Everything downstream (filter, startOn, routing, run/session) runs for real.
   */
  async simulateInject(input: IngestInput): Promise<IngestResult> {
    this.#assertEnabled();
    return startSpan(this.tracer, "webhook.simulate", async (span) => {
      span.setAttribute("opaqueId", input.opaqueId);

      const endpoint = await this.prisma.webhookEndpoint.findFirst({
        where: { opaqueId: input.opaqueId },
      });
      if (!endpoint) return { outcome: "endpoint_not_found" };
      if (endpoint.status !== "ACTIVE") return { outcome: "endpoint_inactive" };

      const parsedArtifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      if (!parsedArtifact.success) {
        return { outcome: "verification_failed", error: "corrupt verifier artifact" };
      }

      const parsed = parseEventBody(input.rawBytes, { headers: input.headers });
      if (parsed.error || parsed.parsedEvent === undefined) {
        return {
          outcome: "verification_failed",
          error: parsed.error ?? "body is not valid JSON",
          response: artifactResponseContract(parsedArtifact.data),
        };
      }

      return this.#recordAndRoute({
        endpoint,
        artifact: parsedArtifact.data,
        targets: parseRoutingTargets(endpoint, this.logger),
        parsedEvent: parsed.parsedEvent,
        idempotencyKey: deriveSimulateIdempotencyKey(parsedArtifact.data, input),
        errorMessage: null,
        rawBytes: input.rawBytes,
        headers: input.headers,
      });
    });
  }

  /**
   * Re-run a past delivery from its stored event and headers (the raw body isn't kept, so this is not
   * a re-verify). A new delivery row with a fresh idempotency key is created so runs actually execute
   * and session actions append anew; it shares the original externalDeliveryId so the two group
   * together. Without `targetId` every current target is re-evaluated against its filter; with it,
   * only that target runs, past its filter.
   */
  async replayDelivery(input: ReplayInput): Promise<ReplayResult> {
    this.#assertEnabled();
    return startSpan(this.tracer, "webhook.replay", async (span) => {
      span.setAttribute("deliveryId", input.id);

      const original = await this.prisma.webhookDelivery.findFirst({
        where: deliveryKey(input.id, input.createdAt),
      });
      if (!original) return { outcome: "delivery_not_found" };

      const endpoint = await this.prisma.webhookEndpoint.findFirst({
        where: { id: original.webhookEndpointId },
      });
      if (!endpoint) return { outcome: "endpoint_not_found" };

      const targets = parseRoutingTargets(endpoint, this.logger);
      let targetResults: WebhookDeliveryTargetResult[];
      if (input.targetId) {
        const match = targets.find(({ target }) => target.id === input.targetId);
        if (!match) return { outcome: "target_not_found" };
        targetResults = [{ ...targetBase(match.target), status: "PENDING" }];
      } else {
        targetResults = this.#evaluateTargets(
          targets,
          original.parsedEvent,
          (original.headers as Record<string, string> | null) ?? {},
          endpoint,
          original.externalDeliveryId
        );
      }
      const configs = new Map(targets.map(({ target }) => [target.id, target]));
      const runnable = targetResults.flatMap((result) => {
        const target = result.status === "PENDING" ? configs.get(result.id) : undefined;
        return target ? [target] : [];
      });
      if (input.authorize) {
        const denied = await input.authorize(runnable.map(replaySubscriber));
        if (denied.length > 0) return { outcome: "forbidden", denied };
      }
      targetResults = targetResults.map((result) => {
        const target = result.status === "PENDING" ? configs.get(result.id) : undefined;
        return target ? { ...result, taskId: replaySubscriber(target).taskId } : result;
      });
      const filtered = !targetResults.some((result) => result.status === "PENDING");

      const {
        id,
        friendlyId,
        timestamp: createdAt,
        retentionDays,
      } = WebhookDeliveryId.generate({
        retentionDays: await this.#retentionDays(original.runtimeEnvironmentId),
      });

      const queued = await this.#enqueueDeliverJob(
        original.runtimeEnvironmentId,
        original.webhookEndpointId,
        {
          deliveryId: id,
          createdAt,
          record: {
            friendlyId,
            retentionDays,
            webhookEndpointId: original.webhookEndpointId,
            organizationId: original.organizationId,
            projectId: original.projectId,
            runtimeEnvironmentId: original.runtimeEnvironmentId,
            environmentType: original.environmentType,
            externalDeliveryId: original.externalDeliveryId,
            idempotencyKey: `replay:${id}`,
            status: filtered ? "FILTERED" : "PENDING",
            isTest: false,
            parsedEvent: original.parsedEvent ?? null,
            headers: (original.headers as Record<string, string> | null) ?? null,
            rawBodyHash: original.rawBodyHash,
            errorMessage: null,
            filterReason: filtered ? summarizeFilterReasons(targetResults) : null,
            targets: targetResults,
          },
        }
      );
      if (queued?.outcome === "queue_full") return queued;
      if (queued) throw new Error(queued.error);

      if (filtered) this.deliveryFilteredCounter.add(1);
      else this.deliveryEnqueueCounter.add(1);

      return { outcome: "replayed", deliveryId: id, deliveryFriendlyId: friendlyId };
    });
  }

  /**
   * Register a webhook waiter on a declared endpoint: validate, reserve a slot (so a limit breach
   * creates no waitpoint or timeout job), mint the MANUAL waitpoint, then register it. A retry with
   * the same idempotency key finds the existing waitpoint and skips the reservation, and `register`
   * answers from the waiter's state record, so a waiter a delivery already claimed is never
   * registered twice. A waiter only matches deliveries that arrive after it was registered.
   */
  async createWaiter(input: CreateWebhookWaiterInput): Promise<CreateWebhookWaiterResult> {
    this.#assertEnabled();
    const result = await this.#createWaiter(input);
    this.waitersCreatedCounter.add(1, {
      outcome: result.outcome === "created" && result.isCached ? "cached" : result.outcome,
    });
    const env = { environmentId: input.environmentId, projectId: input.projectId };
    if (result.outcome === "limit" && result.reason !== "timeout_too_long") {
      const reason = result.reason;
      this.#metric((hooks) => hooks.onWaiterRefused?.(env, reason));
    }
    return result;
  }

  async #waiterCreated(input: CreateWebhookWaiterInput, limit: number) {
    if (!this.options.metrics?.onWaiterCreated) return;
    const liveCount = await this.waiterStore.environmentCount(input.environmentId).catch(() => -1);
    if (liveCount < 0) return;
    const env = { environmentId: input.environmentId, projectId: input.projectId };
    this.#metric((hooks) => hooks.onWaiterCreated?.(env, liveCount, limit));
  }

  #metric(call: (hooks: WebhookEngineMetricsHooks) => unknown) {
    const hooks = this.options.metrics;
    if (!hooks) return;
    const failed = (error: unknown) =>
      this.logger.debug("webhook metrics hook failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    try {
      const result = call(hooks);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  }

  #waitersReleased(env: WebhookMetricsEnvironment) {
    if (!this.options.metrics?.onWaiterReleased) return;
    this.waiterStore.environmentCount(env.environmentId).then(
      (liveCount) => this.#metric((hooks) => hooks.onWaiterReleased?.(env, liveCount)),
      () => {}
    );
  }

  #deliveryWaitersReleased(delivery: WebhookDelivery) {
    this.#waitersReleased({
      environmentId: delivery.runtimeEnvironmentId,
      projectId: delivery.projectId,
      organizationId: delivery.organizationId,
    });
  }

  async #createWaiter(input: CreateWebhookWaiterInput): Promise<CreateWebhookWaiterResult> {
    const ports = this.options.waiters?.waitpoints;
    if (!ports) throw new Error("Webhook waiters are not configured");

    return startSpan(this.tracer, "webhook.waiter.create", async (span) => {
      span.setAttribute("endpoint", input.endpoint);
      const limits: WebhookWaiterLimits = {
        ...this.waiterLimits,
        ...(input.limits?.perEnvironment ? { perEnvironment: input.limits.perEnvironment } : {}),
        ...(input.limits?.perEndpoint ? { perEndpoint: input.limits.perEndpoint } : {}),
      };

      const endpoint = await this.prisma.webhookEndpoint.findFirst({
        where: {
          runtimeEnvironmentId: input.environmentId,
          ...(isWebhookEndpointFriendlyId(input.endpoint)
            ? { friendlyId: input.endpoint }
            : { declaredId: input.endpoint }),
          endpointTenantId: "",
          endpointExternalRef: "",
          status: "ACTIVE",
        },
      });
      if (!endpoint) return { outcome: "endpoint_not_found" };

      const invalidMatch = validateMatch(input.match, limits.paths);
      if (invalidMatch) return { outcome: "invalid", error: invalidMatch };
      if ((input.tags?.length ?? 0) > limits.tags) {
        return { outcome: "invalid", error: `a waiter can have at most ${limits.tags} tags` };
      }
      if (input.filter) {
        try {
          parseFilter(input.filter);
        } catch (error) {
          return {
            outcome: "filter_invalid",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const now = Date.now();
      const timeoutAt = input.timeoutAt ?? new Date(now + limits.defaultTimeoutMs);
      if (timeoutAt.getTime() <= now) {
        return { outcome: "invalid", error: "the timeout must be in the future" };
      }
      if (timeoutAt.getTime() - now > limits.maxTimeoutMs) {
        return {
          outcome: "limit",
          reason: "timeout_too_long",
          message: `the timeout is longer than the ${Math.round(limits.maxTimeoutMs / DAY_MS)} day maximum`,
        };
      }

      const { paths, shape, values } = waiterShape(input.match);
      const idempotencyKey = `${WAITER_IDEMPOTENCY_PREFIX}${input.idempotencyKey ?? randomUUID()}`;
      const token = randomUUID();
      const existing = input.idempotencyKey
        ? await ports.find({ environmentId: input.environmentId, idempotencyKey })
        : undefined;

      let waiterId: string;
      let isCached: boolean;
      let reservedEnvironment = true;
      let expiresAt = timeoutAt;
      if (existing) {
        if (!existing.tags?.includes(`webhook:${endpoint.declaredId}`)) {
          return {
            outcome: "invalid",
            error:
              "this idempotency key belongs to a waitpoint that isn't a waiter on this endpoint",
          };
        }
        waiterId = existing.id;
        isCached = true;
        expiresAt = existing.timeoutAt ?? timeoutAt;
        const index = await this.waiterStore.readIndex(waiterId);
        if (
          index &&
          (index.endpointId !== endpoint.id ||
            index.shape !== shape ||
            index.values !== values ||
            (index.filter ?? "") !== (input.filter ?? ""))
        ) {
          return {
            outcome: "invalid",
            error:
              "this idempotency key already created a waiter on a different endpoint or with a different match or filter",
          };
        }
        if (existing.status === "COMPLETED") {
          return this.#createdWaiter(endpoint, waiterId, shape, expiresAt, true);
        }
        // No waiter record: an earlier attempt crashed before registering, or the waitpoint was
        // made another way. Either way it has no environment slot yet, so take one now.
        if (
          !index &&
          !(await this.waiterStore.reserveEnvironment(
            input.environmentId,
            token,
            limits.perEnvironment
          ))
        ) {
          return {
            outcome: "limit",
            reason: "environment_limit",
            message: waiterLimitMessage("environment_limit", limits),
          };
        }
        reservedEnvironment = !index;
      } else {
        if (
          !(await this.waiterStore.reserveEnvironment(
            input.environmentId,
            token,
            limits.perEnvironment
          ))
        ) {
          return {
            outcome: "limit",
            reason: "environment_limit",
            message: waiterLimitMessage("environment_limit", limits),
          };
        }
        const reserved = await this.waiterStore.reserve(endpoint.id, shape, values, token, limits);
        if (reserved.outcome === "limit") {
          await this.waiterStore.releaseEnvironment(input.environmentId, [`r:${token}`]);
          return {
            outcome: "limit",
            reason: reserved.reason,
            message: waiterLimitMessage(reserved.reason, limits),
          };
        }
        const created = await ports.create({
          environmentId: input.environmentId,
          projectId: input.projectId,
          idempotencyKey,
          idempotencyKeyExpiresAt: input.idempotencyKeyExpiresAt,
          timeoutAt,
          tags: [`webhook:${endpoint.declaredId}`, ...(input.tags ?? [])],
        });
        waiterId = created.id;
        isCached = created.isCached;
      }
      span.setAttribute("waiterId", waiterId);

      await this.waiterStore.writeIndex(waiterId, {
        environmentId: input.environmentId,
        endpointId: endpoint.id,
        shape,
        values,
        expiresAt: expiresAt.getTime(),
        match: input.match,
        filter: input.filter,
      });
      await this.waiterStore.confirmEnvironment(
        input.environmentId,
        reservedEnvironment ? token : undefined,
        waiterId,
        expiresAt.getTime()
      );
      const registered = await this.waiterStore.register({
        endpointId: endpoint.id,
        shape,
        values,
        paths,
        token,
        waiterId,
        expiresAt: expiresAt.getTime(),
        filter: input.filter,
        limits,
      });
      if (registered.outcome !== "registered") {
        await this.waiterStore.releaseEnvironment(input.environmentId, [waiterId, `r:${token}`]);
      }
      if (registered.outcome === "limit") {
        const message = waiterLimitMessage(registered.reason, limits);
        await ports.fail({
          environmentId: input.environmentId,
          waitpointId: waiterId,
          error: { name: "WebhookWaiterLimitError", message, reason: registered.reason },
        });
        return { outcome: "limit", reason: registered.reason, message };
      }

      if (reservedEnvironment) void this.#waiterCreated(input, limits.perEnvironment);
      return this.#createdWaiter(endpoint, waiterId, shape, expiresAt, isCached);
    });
  }

  #createdWaiter(
    endpoint: WebhookEndpoint,
    waiterId: string,
    shape: string,
    expiresAt: Date,
    isCached: boolean
  ): CreateWebhookWaiterResult {
    return {
      outcome: "created",
      id: waiterId,
      ...(shape === waiterShape(undefined).shape
        ? { urlPath: this.#waiterUrlPath(endpoint.opaqueId, waiterId) }
        : {}),
      expiresAt,
      isCached,
    };
  }

  /**
   * Cancel a waiter: frees its slot and fails its wait with `WebhookWaiterCancelledError`. A waiter a
   * delivery already claimed answers `too_late`, and its run resumes with that delivery's event.
   */
  async cancelWaiter(input: {
    environmentId: string;
    waiterId: string;
    /** Only cancel the waiter if it waits on this endpoint. */
    endpointId?: string;
  }): Promise<CancelWebhookWaiterResult> {
    this.#assertEnabled();
    const ports = this.options.waiters?.waitpoints;
    if (!ports) throw new Error("Webhook waiters are not configured");

    return startSpan(this.tracer, "webhook.waiter.cancel", async (span) => {
      span.setAttribute("waiterId", input.waiterId);
      const index = await this.waiterStore.readIndex(input.waiterId);
      if (
        !index ||
        index.environmentId !== input.environmentId ||
        (input.endpointId !== undefined && index.endpointId !== input.endpointId)
      ) {
        return { outcome: "not_found" };
      }

      const result = await this.waiterStore.cancel(
        index.endpointId,
        index.shape,
        index.values,
        input.waiterId
      );
      if (result.outcome === "cancelled") {
        await this.waiterStore.releaseEnvironment(input.environmentId, [input.waiterId]);
        this.#waitersReleased({ environmentId: input.environmentId });
        await ports.fail({
          environmentId: input.environmentId,
          waitpointId: input.waiterId,
          error: {
            name: "WebhookWaiterCancelledError",
            message: "The webhook waiter was cancelled",
          },
        });
      }
      return result;
    });
  }

  /** A page of an endpoint's live waiters, soonest expiry first, for the dashboard. */
  async listWaiters(input: {
    endpointId: string;
    offset?: number;
    limit?: number;
  }): Promise<{ waiters: ListedWebhookWaiter[]; total: number }> {
    this.#assertEnabled();
    const { waiters, total } = await this.waiterStore.listLive(
      input.endpointId,
      Date.now(),
      input.offset ?? 0,
      input.limit ?? 50
    );
    const indexes = await Promise.all(
      waiters.map((waiter) => this.waiterStore.readIndex(waiter.id))
    );
    return {
      waiters: waiters.map((waiter, i) => ({
        id: waiter.id,
        expiresAt: new Date(waiter.expiresAt),
        match: indexes[i]?.match,
        filter: indexes[i]?.filter,
      })),
      total,
    };
  }

  #waiterUrlSignature(opaqueId: string, waiterId: string): string {
    return createHmac("sha256", this.options.waiters?.urlSecret ?? "")
      .update(`${opaqueId}:${waiterId}`)
      .digest("hex")
      .slice(0, 24);
  }

  #waiterUrlPath(opaqueId: string, waiterId: string): string {
    return `/webhooks/v1/ingest/${opaqueId}/w/${waiterId}.${this.#waiterUrlSignature(opaqueId, waiterId)}`;
  }

  /**
   * A delivery to a URL-matched waiter's own URL (`<ingest url>/w/<waiterId>.<signature>`). It is
   * verified with the endpoint's verifier like any delivery, recorded, and can complete only that
   * waiter: it never fans out to the endpoint's subscribers.
   */
  async ingestWaiter(input: IngestInput & { waiterToken: string }): Promise<IngestResult> {
    this.#assertEnabled();
    return this.#countIngest("waiter", this.#ingestWaiter(input));
  }

  async #ingestWaiter(input: IngestInput & { waiterToken: string }): Promise<IngestResult> {
    return startSpan(this.tracer, "webhook.ingest.waiter", async (span) => {
      span.setAttribute("opaqueId", input.opaqueId);

      const dot = input.waiterToken.lastIndexOf(".");
      const waiterId = dot > 0 ? input.waiterToken.slice(0, dot) : "";
      const signature = dot > 0 ? input.waiterToken.slice(dot + 1) : "";
      if (
        !waiterId ||
        !this.options.waiters?.waitpoints ||
        !constantTimeEqual(signature, this.#waiterUrlSignature(input.opaqueId, waiterId))
      ) {
        return { outcome: "endpoint_not_found" };
      }

      const resolved = await this.#resolveEndpoint(input.opaqueId);
      if (!resolved.ok) return resolved.result;
      const { endpoint, secrets } = resolved;

      const parsedArtifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      if (!parsedArtifact.success) {
        return { outcome: "verification_failed", error: "corrupt verifier artifact" };
      }
      const verdict = verifyWithSecrets(
        parsedArtifact.data,
        { rawBytes: input.rawBytes, headers: input.headers, url: input.url },
        secrets
      );
      if (!verdict.ok) {
        return {
          outcome: "verification_failed",
          error: verdict.error ?? "invalid",
          response: artifactResponseContract(parsedArtifact.data),
        };
      }

      return this.#recordAndRoute({
        endpoint,
        artifact: parsedArtifact.data,
        targets: [],
        parsedEvent: verdict.parsedEvent,
        idempotencyKey: verdict.idempotencyKey,
        errorMessage: verdict.error ?? null,
        rawBytes: input.rawBytes,
        headers: input.headers,
        waiterId,
      });
    });
  }

  async #resolveEndpoint(
    opaqueId: string
  ): Promise<({ ok: true } & ResolvedEndpoint) | { ok: false; result: IngestResult }> {
    // Single-row via the global @unique on opaqueId (Q2).
    const endpoint = await this.replica.webhookEndpoint.findFirst({ where: { opaqueId } });
    if (!endpoint) return { ok: false, result: { outcome: "endpoint_not_found" } };
    if (endpoint.status !== "ACTIVE")
      return { ok: false, result: { outcome: "endpoint_inactive" } };

    // Injected port keeps the engine SecretStore-free.
    const resolvedSecret = endpoint.signingSecretKey
      ? await this.options.resolveSigningSecret(endpoint.signingSecretKey)
      : undefined;
    const [secret, ...previousSecrets] = (
      Array.isArray(resolvedSecret) ? resolvedSecret : [resolvedSecret]
    ).filter((value): value is string => Boolean(value));
    if (!secret) {
      const artifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      return {
        ok: false,
        result: {
          outcome: "secret_missing",
          response: artifact.success ? artifactResponseContract(artifact.data) : undefined,
        },
      };
    }

    const targets = parseRoutingTargets(endpoint, this.logger);

    return { ok: true, endpoint, secrets: [secret, ...previousSecrets], targets };
  }

  // Evaluate a session routing target's `startOn` against the event. Absent => start allowed. A parse or
  // eval error fails open (start allowed), matching the route filter, so a bad predicate never wedges a
  // session. Parsed per delivery: only on the session path, and cheap relative to the DB + S2 work.
  #evaluateSessionStart(
    startOn: string | undefined,
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint
  ): boolean {
    if (!startOn) return true;
    try {
      const result = evaluateFilter(parseFilter(startOn), {
        event: delivery.parsedEvent,
        headers: (delivery.headers as Record<string, string> | null) ?? {},
        webhook: {
          externalRef: endpoint.endpointExternalRef,
          tenantId: endpoint.endpointTenantId,
          id: endpoint.declaredId,
          source: endpoint.source,
          deliveryId: delivery.externalDeliveryId,
        },
      });
      return result.match;
    } catch (error) {
      this.logger.warn("webhook startOn evaluation failed, allowing start (fail-open)", {
        endpointId: endpoint.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  /**
   * Evaluate every target's filter against the verified delivery in one pass: `PENDING` for each target
   * that passes (or has no filter), `FILTERED` with the failing clause for each that doesn't.
   */
  #evaluateTargets(
    targets: ParsedRoutingTarget[],
    parsedEvent: unknown,
    headers: Record<string, string>,
    endpoint: WebhookEndpoint,
    deliveryId: string
  ): WebhookDeliveryTargetResult[] {
    return targets.map(({ target, filterAst }) => {
      const { filtered, reason } = this.#evaluateFilter(
        filterAst,
        parsedEvent,
        headers,
        endpoint,
        deliveryId
      );
      const base = targetBase(target);
      return filtered
        ? { ...base, status: "FILTERED", ...(reason ? { reason } : {}) }
        : { ...base, status: "PENDING" };
    });
  }

  /** One target's filter. Fail-open: an evaluation error routes the delivery and is logged. */
  #evaluateFilter(
    filterAst: FilterAst | null,
    parsedEvent: unknown,
    headers: Record<string, string>,
    endpoint: WebhookEndpoint,
    deliveryId: string
  ): { filtered: boolean; reason: string | null } {
    if (!filterAst) return { filtered: false, reason: null };
    try {
      const result = evaluateFilter(filterAst, {
        event: parsedEvent,
        headers,
        webhook: {
          externalRef: endpoint.endpointExternalRef,
          tenantId: endpoint.endpointTenantId,
          id: endpoint.declaredId,
          source: endpoint.source,
          deliveryId,
        },
      });
      return result.match
        ? { filtered: false, reason: null }
        : { filtered: true, reason: result.reason ?? null };
    } catch (error) {
      this.logger.warn("webhook filter evaluation failed, routing (fail-open)", {
        endpointId: endpoint.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { filtered: false, reason: null };
    }
  }

  // Best-effort dedupe window. Capped at the configured max; the durable Run Engine
  // idempotencyKey gate is the real guard for late retries past this window.
  #frontGateTtlSeconds(_artifact: WebhookVerifierArtifact): number {
    const def = this.options.frontGate?.defaultTtlSeconds ?? 6 * 60 * 60;
    const max = this.options.frontGate?.maxTtlSeconds ?? 6 * 60 * 60;
    return Math.min(def, max);
  }

  /**
   * The retention class a new delivery in this environment is stamped with. A failed lookup falls
   * back to the default rather than refusing the delivery.
   */
  async #retentionDays(environmentId: string): Promise<number> {
    const fallback = this.options.retention?.defaultDays ?? 30;
    const lookup = this.options.retention?.forEnvironment;
    let days = fallback;
    if (lookup) {
      try {
        days = await lookup(environmentId);
      } catch (error) {
        this.logger.warn("Couldn't resolve webhook delivery retention, using the default", {
          environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return webhookDeliveryRetentionClassAtLeast(days).days;
  }

  /**
   * webhook.deliver: route a delivery to every target still `PENDING` on it, in parallel, and write
   * each result back into `targets`. A retry skips targets that already finished, so each target's
   * side effect runs until it succeeds or fails terminally. Transient failures with attempts left
   * reset the row to `PENDING` and throw so redis-worker retries; on the final attempt they are FAILED.
   */
  async #handleDeliverJob({ payload, attempt }: { payload: DeliverJobPayload; attempt: number }) {
    return startSpan(this.tracer, "webhook.deliver", async (span) => {
      span.setAttribute("deliveryId", payload.deliveryId);
      this.deliveryExecutionCounter.add(1);
      const start = performance.now();

      const written = await this.#writeDeliveryRow(payload);
      if (!written) {
        this.logger.error("webhook.deliver: delivery not found", {
          deliveryId: payload.deliveryId,
        });
        return;
      }
      const { delivery, inserted } = written;

      if (TERMINAL_DELIVERY_STATUSES.has(delivery.status)) {
        this.logger.debug("webhook.deliver: already terminal", {
          deliveryId: delivery.id,
          status: delivery.status,
        });
        return;
      }

      const endpoint = await this.prisma.webhookEndpoint.findFirst({
        where: { id: delivery.webhookEndpointId },
      });
      if (!endpoint) {
        await this.#markFailed(delivery, "Endpoint not found");
        return;
      }

      if (!inserted || delivery.status !== "PROCESSING") {
        await this.prisma.webhookDelivery.update({
          where: { id_createdAt_retentionDays: primaryKey(delivery) },
          data: { status: "PROCESSING" },
        });
      }

      const configs = new Map(
        parseRoutingTargets(endpoint, this.logger).map(({ target }) => [target.id, target])
      );
      const context = endpointContext(endpoint);
      const isFinalAttempt = attempt >= WEBHOOK_JOB_MAX_ATTEMPTS - 1;
      const stored = parseDeliveryTargets(delivery.targets);
      const results = stored.filter((result) => result.type !== "waiter");
      const previousWaiters = stored.find((result) => result.type === "waiter");
      span.setAttribute("targets", results.length);

      const pendingIndexes = results.flatMap((result, index) =>
        result.status === "PENDING" ? [index] : []
      );
      const waiterStep =
        payload.arrivedAt !== undefined && this.options.waiters?.waitpoints
          ? this.#deliverToWaiters({
              delivery,
              endpoint,
              context,
              arrivedAt: payload.arrivedAt,
              urlWaiterId: payload.waiterId,
              liveAtArrival: payload.liveWaiters ?? false,
              previous: previousWaiters,
              isRetry: attempt > 0 || previousWaiters !== undefined,
              isFinalAttempt,
            })
          : Promise.resolve<WaiterStepResult>({
              summary: previousWaiters,
              hadLiveWaiters: false,
              deferred: false,
            });
      const settledPromise = Promise.allSettled(
        pendingIndexes.map((index) => {
          const target = configs.get(results[index].id);
          if (!target) {
            return Promise.resolve<TargetOutcome>({
              kind: "failed",
              error: "Target is no longer declared on the endpoint",
            });
          }
          const authorizedTask = results[index].taskId;
          if (
            authorizedTask &&
            (target.type !== results[index].type ||
              replaySubscriber(target).taskId !== authorizedTask)
          ) {
            return Promise.resolve<TargetOutcome>({
              kind: "failed",
              error: `The subscriber changed since the replay was authorized (it was a ${results[index].type} for ${authorizedTask})`,
            });
          }
          return target.type === "task"
            ? this.#deliverToTask(delivery, endpoint, target, context)
            : this.#deliverToSession(delivery, endpoint, target, context);
        })
      );
      const [settled, waiters] = await Promise.all([settledPromise, waiterStep]);

      let infrastructureFailure = false;
      pendingIndexes.forEach((index, i) => {
        const result = settled[i];
        const outcome: TargetOutcome =
          result.status === "fulfilled"
            ? result.value
            : isInfrastructureError(result.reason)
              ? { kind: "transient", infrastructure: true }
              : {
                  kind: "transient",
                  error:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
                };
        const infrastructure = outcome.kind === "transient" && outcome.infrastructure === true;
        infrastructureFailure ||= infrastructure;
        results[index] = applyTargetOutcome(
          results[index],
          outcome,
          isFinalAttempt && !infrastructure
        );
      });

      this.deliveryExecutionDuration.record(performance.now() - start);
      await this.#finishDelivery(
        delivery,
        results,
        waiters,
        infrastructureFailure || waiters.infrastructure === true
      );
    });
  }

  /**
   * Write every target's and waiter's result back and settle the delivery's status: PENDING (and
   * throw, so it retries) while anything transient has attempts left, FAILED when something failed
   * terminally, SUCCEEDED when anything routed, UNMATCHED when the endpoint had live waiters but
   * nothing matched, otherwise FILTERED.
   */
  async #finishDelivery(
    delivery: WebhookDelivery,
    targetResults: WebhookDeliveryTargetResult[],
    waiters: WaiterStepResult,
    infrastructureFailure = false
  ) {
    const where = { id_createdAt_retentionDays: primaryKey(delivery) };
    const results = waiters.summary ? [...targetResults, waiters.summary] : [...targetResults];
    const targets = results as unknown as Prisma.InputJsonValue;
    const runId = results.find((result) => result.status === "SUCCEEDED" && result.runId)?.runId;
    const pending = results.filter(
      (result) => result.status === "PENDING" && !(waiters.deferred && result.type === "waiter")
    );
    const failed = results.filter((result) => result.status === "FAILED");

    if (pending.length > 0) {
      const message = describeTargetErrors(pending.filter((result) => result.error));
      await this.prisma.webhookDelivery.update({
        where,
        data: { status: "PENDING", targets, runId: runId ?? null, errorMessage: message || null },
      });
      this.deliveryExecutionFailureCounter.add(1);
      throw infrastructureFailure
        ? new WebhookInfrastructureError(message || "webhook delivery failed on our infrastructure")
        : new Error(message);
    }

    if (waiters.deferred) {
      await this.prisma.webhookDelivery.update({
        where,
        data: { status: "PROCESSING", targets, runId: runId ?? null, errorMessage: null },
      });
      await this.#settleWaiterDelivery(delivery.id, delivery.createdAt);
      return;
    }

    if (failed.length > 0) {
      this.deliveryExecutionFailureCounter.add(1);
      await this.#settle(delivery, results, {
        status: "FAILED",
        targets,
        runId: runId ?? null,
        errorMessage: describeTargetErrors(failed),
      });
      return;
    }

    if (results.some((result) => result.status === "SUCCEEDED")) {
      await this.#settle(delivery, results, {
        status: "SUCCEEDED",
        targets,
        runId: runId ?? null,
        errorMessage: null,
      });
      return;
    }

    await this.#settle(delivery, results, {
      status: waiters.hadLiveWaiters ? "UNMATCHED" : "FILTERED",
      targets,
      filterReason:
        waiters.hadLiveWaiters && targetResults.length === 0
          ? "no live waiter matched"
          : summarizeFilterReasons(targetResults),
      errorMessage: null,
    });
  }

  /**
   * Write a delivery's final status if it hasn't settled yet, and record the settlement only when
   * this write is the one that settled it, so concurrent waiter chunks or a retried write count once.
   */
  async #settle(
    delivery: WebhookDelivery,
    results: WebhookDeliveryTargetResult[],
    data: Prisma.WebhookDeliveryUpdateManyMutationInput & { status: WebhookDeliveryStatus }
  ) {
    const { count } = await this.prisma.webhookDelivery.updateMany({
      where: { ...primaryKey(delivery), status: { in: ["PENDING", "PROCESSING"] } },
      data: { ...data, processedAt: new Date() },
    });
    if (count > 0) this.#recordSettled(delivery.createdAt, data.status, results);
  }

  #recordSettled(createdAt: Date, status: string, results: WebhookDeliveryTargetResult[]) {
    this.deliverySettleLatency.record(Math.max(Date.now() - createdAt.getTime(), 0), { status });
    for (const result of results) {
      this.targetResultCounter.add(1, { type: result.type, status: result.status });
    }
  }

  /**
   * The waiter step: find the live waiters this delivery matches (registered no later than its
   * arrival, filter passing) and claim them in one script. Up to one chunk of waiters is resumed
   * here; a larger claim is split across `webhook.completeWaiters` jobs and the delivery stays
   * PROCESSING until the last one settles it. A retry gets the already-claimed, unresolved ids back
   * from the claim record instead of matching again. Never throws: a store or completion failure
   * leaves the waiters PENDING so the delivery retries.
   */
  async #deliverToWaiters(args: {
    delivery: WebhookDelivery;
    endpoint: WebhookEndpoint;
    context: WebhookEndpointContext;
    arrivedAt: number;
    urlWaiterId: string | undefined;
    liveAtArrival: boolean;
    previous: WebhookDeliveryTargetResult | undefined;
    isRetry: boolean;
    isFinalAttempt: boolean;
  }): Promise<WaiterStepResult> {
    const { delivery, endpoint, context, arrivedAt, urlWaiterId, isFinalAttempt } = args;
    let hadLiveWaiters =
      args.liveAtArrival || args.previous !== undefined || urlWaiterId !== undefined;

    try {
      const groups = urlWaiterId
        ? await this.#urlWaiterCandidates(delivery, endpoint, urlWaiterId, arrivedAt)
        : await this.#matchedWaiterCandidates(delivery, endpoint, arrivedAt);
      hadLiveWaiters ||= groups.live;

      if (groups.candidates.length === 0 && !args.isRetry) {
        return { hadLiveWaiters, deferred: false };
      }

      const claim = await this.waiterStore.claim(endpoint.id, delivery.id, groups.candidates);
      if (claim.claimed === 0) return { hadLiveWaiters, deferred: false };
      hadLiveWaiters = true;

      const chunkSize =
        this.options.waiters?.completionChunkSize ?? DEFAULT_WAITER_COMPLETION_CHUNK;
      if (!claim.decided) {
        this.waiterClaimSize.record(claim.claimed, { chunked: claim.claimed > chunkSize });
      }
      if (claim.claimed > chunkSize) {
        if (claim.ids.length > 0) {
          await this.#enqueueWaiterChunks(delivery, Math.ceil(claim.claimed / chunkSize));
        }
        const counts = {
          claimed: claim.claimed,
          failed: claim.failed,
          remaining: claim.ids.length,
        };
        return { summary: waiterSummary(counts), hadLiveWaiters, deferred: counts.remaining > 0 };
      }

      const resumed = await this.#resumeWaiters(
        delivery,
        endpoint,
        context,
        claim.ids,
        isFinalAttempt
      );
      return {
        summary: waiterSummary(resumed.counts, resumed.error),
        hadLiveWaiters,
        deferred: false,
        infrastructure: resumed.infrastructure,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const infrastructure = isInfrastructureError(error);
      this.logger.warn("webhook.deliver: waiter step failed", {
        deliveryId: delivery.id,
        error: message,
      });
      return {
        summary: {
          id: "waiters",
          type: "waiter",
          status: isFinalAttempt && !infrastructure ? "FAILED" : "PENDING",
          ...(infrastructure ? {} : { error: message }),
          ...(args.previous?.waiters ? { waiters: args.previous.waiters } : {}),
        },
        hadLiveWaiters: true,
        deferred: false,
        infrastructure,
      };
    }
  }

  /**
   * Resume claimed waiters with the delivery's shared packet and take the resumed ones out of the
   * claim record. A waiter whose completion failed stays claimed for the next attempt, and is given
   * up on (counted as failed) on the final one, unless it failed on our infrastructure: those stay
   * claimed and keep retrying for as long as the failure lasts.
   */
  async #resumeWaiters(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    context: WebhookEndpointContext,
    ids: string[],
    isFinalAttempt: boolean
  ): Promise<{ counts: ClaimCounts; unresolved: number; error?: string; infrastructure: boolean }> {
    const completions: Array<{
      id: string;
      ok: boolean;
      error?: string;
      infrastructure?: boolean;
    }> =
      ids.length === 0
        ? []
        : await this.options
            .waiters!.waitpoints!.complete({
              environmentId: delivery.runtimeEnvironmentId,
              waitpointIds: ids,
              output: {
                event: delivery.parsedEvent,
                headers: (delivery.headers as Record<string, string> | null) ?? {},
                deliveryId: delivery.friendlyId,
                endpoint: context,
              },
              deliveryFriendlyId: delivery.friendlyId,
            })
            .catch((error: unknown) => {
              const infrastructure = isInfrastructureError(error);
              const message = error instanceof Error ? error.message : String(error);
              if (infrastructure) {
                this.logger.warn("webhook waiter completion failed on our infrastructure", {
                  deliveryId: delivery.id,
                  error: message,
                });
              }
              return ids.map((id) => ({
                id,
                ok: false,
                ...(infrastructure ? {} : { error: message }),
                infrastructure,
              }));
            });
    const retryable = new Set(
      completions.filter((c) => !c.ok && c.infrastructure).map((c) => c.id)
    );
    const infrastructure = retryable.size > 0;
    const resumed = new Set(completions.filter((c) => c.ok).map((c) => c.id));
    const notResumed = ids.filter((id) => !resumed.has(id));
    const failedOnDelivery = notResumed.filter((id) => !retryable.has(id));
    const givingUp = isFinalAttempt ? failedOnDelivery : [];
    const error =
      completions.find((completion) => !completion.ok && !completion.infrastructure)?.error ??
      (failedOnDelivery.length > 0 ? "waiter completion failed" : undefined);

    // Free the environment slots before acking the claims: a retry only sees unacked claims, so a
    // release that failed after its ack would never be retried.
    await this.waiterStore.releaseEnvironment(delivery.runtimeEnvironmentId, [...resumed]);
    if (resumed.size > 0) this.#deliveryWaitersReleased(delivery);
    let counts = await this.waiterStore.resolve(endpoint.id, delivery.id, "ok", [...resumed]);
    if (resumed.size > 0) this.waitersResolvedCounter.add(resumed.size, { result: "resumed" });
    if (givingUp.length > 0) {
      await this.waiterStore.releaseEnvironment(delivery.runtimeEnvironmentId, givingUp);
      this.#deliveryWaitersReleased(delivery);
      counts = await this.waiterStore.resolve(endpoint.id, delivery.id, "failed", givingUp, error);
      this.waitersResolvedCounter.add(givingUp.length, { result: "failed" });
    }
    return { counts, unresolved: notResumed.length - givingUp.length, error, infrastructure };
  }

  async #enqueueWaiterChunks(delivery: WebhookDelivery, chunks: number) {
    await Promise.all(
      Array.from({ length: chunks }, (_, chunk) =>
        this.jobQueue.enqueue({
          id: `webhook-waiters:${delivery.id}:${chunk}`,
          environmentId: delivery.runtimeEnvironmentId,
          endpointId: delivery.webhookEndpointId,
          job: {
            job: "webhook.completeWaiters",
            payload: { deliveryId: delivery.id, createdAt: delivery.createdAt, chunk, chunks },
          },
        })
      )
    );
  }

  /**
   * webhook.completeWaiters: resume one chunk of a delivery's claimed waiters. The chunk is every
   * unresolved claimed id that hashes to it, so the split is the same on every attempt of every
   * job. The job then settles the delivery if it was the last one out.
   */
  async #handleCompleteWaitersJob({
    payload,
    attempt,
  }: {
    payload: CompleteWaitersJobPayload;
    attempt: number;
  }) {
    return startSpan(this.tracer, "webhook.completeWaiters", async (span) => {
      span.setAttribute("deliveryId", payload.deliveryId);
      span.setAttribute("chunk", payload.chunk);

      if (!this.options.waiters?.waitpoints) return;
      const delivery = await this.prisma.webhookDelivery.findFirst({
        where: deliveryKey(payload.deliveryId, payload.createdAt),
      });
      if (!delivery || TERMINAL_DELIVERY_STATUSES.has(delivery.status)) return;
      const endpoint = await this.prisma.webhookEndpoint.findFirst({
        where: { id: delivery.webhookEndpointId },
      });
      if (!endpoint) return;

      const ids = (await this.waiterStore.unresolved(endpoint.id, delivery.id)).filter(
        (id) => waiterChunk(id, payload.chunks) === payload.chunk
      );
      span.setAttribute("waiters", ids.length);
      if (ids.length > 0) {
        const resumed = await this.#resumeWaiters(
          delivery,
          endpoint,
          endpointContext(endpoint),
          ids,
          attempt >= WEBHOOK_JOB_MAX_ATTEMPTS - 1
        );
        if (resumed.unresolved > 0) {
          const message = `${resumed.unresolved} waiters could not be resumed: ${
            resumed.error ?? "unknown error"
          }`;
          throw resumed.infrastructure
            ? new WebhookInfrastructureError(message)
            : new Error(message);
        }
      }
      await this.#settleWaiterDelivery(delivery.id, delivery.createdAt);
    });
  }

  /**
   * Settle a delivery whose waiters completion jobs are resuming: once every claimed waiter is
   * resolved and no subscriber is still retrying, write its final status. Safe to run from any job
   * any number of times.
   */
  async #settleWaiterDelivery(deliveryId: string, createdAt: Date) {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: deliveryKey(deliveryId, createdAt),
    });
    if (!delivery || TERMINAL_DELIVERY_STATUSES.has(delivery.status)) return;

    const stored = parseDeliveryTargets(delivery.targets);
    const targetResults = stored.filter((result) => result.type !== "waiter");
    if (targetResults.some((result) => result.status === "PENDING")) return;

    const counts = await this.waiterStore.resolve(delivery.webhookEndpointId, delivery.id, "ok");
    if (counts.remaining > 0) return;

    const previous = stored.find((result) => result.type === "waiter");
    await this.#finishDelivery(delivery, targetResults, {
      summary: waiterSummary(counts, previous?.error),
      hadLiveWaiters: true,
      deferred: false,
    });
  }

  async #matchedWaiterCandidates(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    arrivedAt: number
  ): Promise<{ candidates: WaiterCandidateGroup[]; live: boolean }> {
    const shapes = await this.waiterStore.liveShapes(endpoint.id, arrivedAt);
    if (shapes.length === 0) return { candidates: [], live: false };

    const headers = (delivery.headers as Record<string, string> | null) ?? {};
    const namespaces = {
      body: delivery.parsedEvent,
      webhook: this.#webhookNamespace(endpoint, delivery.externalDeliveryId),
      header: headers,
    };
    const filters = new Map<string, FilterAst | null>();
    const candidates: WaiterCandidateGroup[] = [];

    const keyed = shapes.flatMap(({ shape, paths }) => {
      const values = eventValues(paths, namespaces);
      return values ? [{ shape, key: valuesHash(paths, values) }] : [];
    });
    const lives = await Promise.all(
      keyed.map(({ shape, key }) =>
        this.waiterStore.liveWaiters(endpoint.id, shape, key, arrivedAt)
      )
    );
    keyed.forEach(({ shape, key }, i) => {
      const ids = lives[i]!.filter((waiter) => waiter.registeredAt <= arrivedAt)
        .filter((waiter) =>
          this.#waiterFilterPasses(waiter.filter, filters, delivery, endpoint, headers)
        )
        .map((waiter) => waiter.id);
      if (ids.length > 0) candidates.push({ shape, values: key, ids });
    });
    return { candidates, live: candidates.length > 0 };
  }

  /** Header names the endpoint's live waiters match on, so the stored headers keep them. */
  async #waiterHeaderNames(endpointId: string, arrivedAt: number): Promise<Set<string>> {
    const shapes = await this.waiterStore.liveShapes(endpointId, arrivedAt).catch(() => []);
    return new Set(
      shapes.flatMap(({ paths }) =>
        paths
          .filter((path) => path.startsWith("header."))
          .map((path) => path.slice(7).toLowerCase())
      )
    );
  }

  async #urlWaiterCandidates(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    waiterId: string,
    arrivedAt: number
  ): Promise<{ candidates: WaiterCandidateGroup[]; live: boolean }> {
    const { shape, values } = waiterShape(undefined);
    const live = await this.waiterStore.liveWaiters(endpoint.id, shape, values, arrivedAt);
    const headers = (delivery.headers as Record<string, string> | null) ?? {};
    const waiter = live.find(
      (w) =>
        w.id === waiterId &&
        w.registeredAt <= arrivedAt &&
        this.#waiterFilterPasses(w.filter, new Map(), delivery, endpoint, headers)
    );
    return { candidates: waiter ? [{ shape, values, ids: [waiter.id] }] : [], live: true };
  }

  /** A waiter's filter. Fail-closed: a waiter never resumes on an event its filter can't evaluate. */
  #waiterFilterPasses(
    filter: string | undefined,
    cache: Map<string, FilterAst | null>,
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    headers: Record<string, string>
  ): boolean {
    if (!filter) return true;
    let ast = cache.get(filter);
    if (ast === undefined) {
      try {
        ast = parseFilter(filter);
      } catch {
        ast = null;
      }
      cache.set(filter, ast);
    }
    if (!ast) return false;
    try {
      return evaluateFilter(ast, {
        event: delivery.parsedEvent,
        headers,
        webhook: this.#webhookNamespace(endpoint, delivery.externalDeliveryId),
      }).match;
    } catch (error) {
      this.logger.warn("webhook waiter filter evaluation failed, not matching (fail-closed)", {
        endpointId: endpoint.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  #webhookNamespace(endpoint: WebhookEndpoint, deliveryId: string) {
    return {
      externalRef: endpoint.endpointExternalRef,
      tenantId: endpoint.endpointTenantId,
      id: endpoint.declaredId,
      source: endpoint.source,
      deliveryId,
    };
  }

  async #deliverToTask(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    target: TaskTarget,
    context: WebhookEndpointContext
  ): Promise<TargetOutcome> {
    const identityTags = [
      `webhook:endpoint:${endpoint.id}`,
      `webhook:source:${endpoint.source}`,
      ...(endpoint.endpointTenantId ? [`webhook:tenant:${endpoint.endpointTenantId}`] : []),
    ];

    const result = await this.options.triggerTask({
      environmentId: delivery.runtimeEnvironmentId,
      taskId: target.taskId,
      targetId: target.id,
      deliveryId: delivery.friendlyId,
      endpoint: context,
      idempotencyKey: `${endpoint.id}:${delivery.idempotencyKey}`,
      idempotencyKeyExpiresAt: this.#retryWindowExpiry(endpoint),
      payload: delivery.parsedEvent,
      headers: (delivery.headers as Record<string, string> | null) ?? {},
      identityTags,
      endpointMetadata: endpoint.metadata,
    });

    return outcomeFromPortResult(result);
  }

  /**
   * Route to a session: resolve the key template to the session externalId, then hand off to the
   * deliverToSession port (find-or-create the session, append the action under `partId`).
   */
  async #deliverToSession(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    target: SessionTarget,
    context: WebhookEndpointContext
  ): Promise<TargetOutcome> {
    if (!this.options.deliverToSession) {
      return { kind: "failed", error: "Session delivery is not configured" };
    }

    const externalId = evaluateSessionKeyTemplate(target.keyTemplate, {
      body: delivery.parsedEvent,
      webhook: {
        externalRef: endpoint.endpointExternalRef ?? "",
        tenantId: endpoint.endpointTenantId ?? "",
        id: endpoint.declaredId,
        source: endpoint.source,
        deliveryId: delivery.externalDeliveryId,
      },
      header: (delivery.headers as Record<string, string> | null) ?? {},
    });
    if (!externalId) {
      return {
        kind: "failed",
        error: `Session key resolved empty: ${displaySessionKeyTemplate(target.keyTemplate)}`,
      };
    }

    const partId = `${delivery.id}:${target.id}`;
    const result = await this.options.deliverToSession({
      environmentId: delivery.runtimeEnvironmentId,
      taskIdentifier: target.taskIdentifier,
      targetId: target.id,
      partId,
      endpoint: context,
      externalId,
      deliverAs: target.deliverAs,
      actionType: target.actionType,
      connectorId: target.connectorId,
      event: delivery.parsedEvent,
      source: endpoint.source,
      headers: (delivery.headers as Record<string, string> | null) ?? {},
      deliveryId: delivery.friendlyId,
      externalDeliveryId: delivery.externalDeliveryId,
      triggerConfigTemplate: target.triggerConfigTemplate,
      idempotencyKey: delivery.idempotencyKey,
      isSessionStart: this.#evaluateSessionStart(target.startOn, delivery, endpoint),
      claimPart: () =>
        this.waiterStore.claimSessionPart(
          endpoint.id,
          partId,
          SESSION_PART_CLAIM_TTL_SECONDS,
          SESSION_PART_LEASE_MS
        ),
      commitPart: () => this.waiterStore.commitSessionPart(endpoint.id, partId),
      releasePart: () => this.waiterStore.releaseSessionPart(endpoint.id, partId),
    });

    return outcomeFromPortResult(result);
  }

  /**
   * A job that threw on its last attempt (a database error, say, rather than a target failing). A
   * delivery job fails its delivery unless it already settled, so it isn't left PENDING or
   * PROCESSING with no job left to finish it, and it can be replayed from there. A waiter chunk
   * gives up only its own claimed waiters, as its final attempt would have, and settles the delivery
   * if it was the last one out, so the other chunks still resume theirs. Both are safe to repeat.
   */
  async #handleExhaustedJob(job: WebhookJob, error: Error) {
    const message = `Processing failed after ${WEBHOOK_JOB_MAX_ATTEMPTS} attempts: ${error.message}`;
    if (job.job === "webhook.completeWaiters") {
      const { deliveryId, createdAt, chunk, chunks } = job.payload;
      const delivery = await this.prisma.webhookDelivery.findFirst({
        where: deliveryKey(deliveryId, createdAt),
      });
      if (!delivery || TERMINAL_DELIVERY_STATUSES.has(delivery.status)) return;
      const ids = (
        await this.waiterStore.unresolved(delivery.webhookEndpointId, delivery.id)
      ).filter((id) => waiterChunk(id, chunks) === chunk);
      if (ids.length > 0) {
        await this.waiterStore.releaseEnvironment(delivery.runtimeEnvironmentId, ids);
        this.#deliveryWaitersReleased(delivery);
        await this.waiterStore.resolve(
          delivery.webhookEndpointId,
          delivery.id,
          "failed",
          ids,
          message
        );
        this.waitersResolvedCounter.add(ids.length, { result: "failed" });
      }
      await this.#settleWaiterDelivery(delivery.id, delivery.createdAt);
      return;
    }

    const written = await this.#writeDeliveryRow(job.payload, {
      status: "FAILED",
      errorMessage: message,
      processedAt: new Date(),
    });
    if (written?.inserted) {
      this.deliveryExecutionFailureCounter.add(1);
      this.#recordSettled(new Date(job.payload.createdAt), "FAILED", []);
      return;
    }
    const { count } = await this.prisma.webhookDelivery.updateMany({
      where: {
        ...deliveryKey(job.payload.deliveryId, job.payload.createdAt),
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "FAILED", errorMessage: message, processedAt: new Date() },
    });
    if (count > 0) {
      this.deliveryExecutionFailureCounter.add(1);
      this.#recordSettled(job.payload.createdAt, "FAILED", []);
    }
  }

  /**
   * Write a deliver job's delivery row, once: a re-run of the job (a retry, a reclaimed lease, or a
   * provider retry that queued it again) finds the row already there and reads it instead. A routed
   * delivery is written PROCESSING, since this job is about to route it.
   */
  async #writeDeliveryRow(
    payload: DeliverJobPayload,
    override?: { status: WebhookDeliveryStatus; errorMessage: string; processedAt: Date }
  ): Promise<{ delivery: WebhookDelivery; inserted: boolean } | undefined> {
    const createdAt = new Date(payload.createdAt);
    const { record } = payload;
    const status = override?.status ?? (record.status === "PENDING" ? "PROCESSING" : record.status);
    try {
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          id: payload.deliveryId,
          createdAt,
          friendlyId: record.friendlyId,
          retentionDays: record.retentionDays,
          webhookEndpointId: record.webhookEndpointId,
          organizationId: record.organizationId,
          projectId: record.projectId,
          runtimeEnvironmentId: record.runtimeEnvironmentId,
          environmentType: record.environmentType as WebhookDelivery["environmentType"],
          externalDeliveryId: record.externalDeliveryId,
          idempotencyKey: record.idempotencyKey,
          status,
          isTest: record.isTest,
          parsedEvent: (record.parsedEvent ?? undefined) as Prisma.InputJsonValue | undefined,
          headers: (record.headers ?? undefined) as Prisma.InputJsonValue | undefined,
          rawBodyHash: record.rawBodyHash,
          errorMessage: override?.errorMessage ?? record.errorMessage,
          filterReason: record.filterReason,
          targets: record.targets as Prisma.InputJsonValue,
          ...(override ? { processedAt: override.processedAt } : {}),
        },
      });
      if (!override && record.status === "FILTERED") {
        this.#recordSettled(createdAt, "FILTERED", parseDeliveryTargets(record.targets));
      }
      return { delivery, inserted: true };
    } catch (error) {
      if ((error as { code?: unknown }).code !== "P2002") throw error;
      const delivery = await this.prisma.webhookDelivery.findFirst({
        where: deliveryKey(payload.deliveryId, createdAt),
      });
      return delivery ? { delivery, inserted: false } : undefined;
    }
  }

  async #markFailed(delivery: WebhookDelivery, message: string) {
    this.deliveryExecutionFailureCounter.add(1);
    await this.#settle(delivery, [], { status: "FAILED", errorMessage: message });
  }

  #retryWindowExpiry(endpoint: WebhookEndpoint): Date {
    return new Date(Date.now() + resolveRetryWindowSeconds(endpoint) * 1000);
  }

  /**
   * Pre-create dated delivery partitions ahead and drop cold ones. The host runs it on a schedule
   * (it is idempotent, so overlapping runs are harmless).
   */
  async ensurePartitions() {
    return startSpan(this.tracer, "ensurePartitions", async (span) => {
      this.ensurePartitionsCounter.add(1);
      const result = await ensurePartitions(this.options.partitionPrisma ?? this.prisma, {
        now: new Date(),
        lookaheadDays: this.options.partitions?.lookaheadDays ?? 10,
      });
      span.setAttribute("created", result.created.length);
      span.setAttribute("dropped", result.dropped.length);
      span.setAttribute("deferred", result.deferred.length);
      span.setAttribute("unmanaged", result.unmanaged.length);
      if (result.unmanaged.length > 0) {
        this.logger.error("webhook delivery partitions outside every retention class", {
          unmanaged: result.unmanaged,
        });
      }
      await this.#refreshPartitionCoverage();
      this.logger.info("webhook ensurePartitions", result);
    });
  }

  /** Read when the first retention class runs out of leaves, for the partitions-ahead gauge. */
  async #refreshPartitionCoverage() {
    this.partitionsCoveredUntil = partitionsCoveredUntil(
      await listDatedPartitions(this.options.partitionPrisma ?? this.prisma)
    );
  }

  /** Live waiters an environment holds across its endpoints (what the environment cap counts). */
  async countLiveWaiters(environmentId: string) {
    this.#assertEnabled();
    return this.waiterStore.environmentCount(environmentId);
  }

  /**
   * Wait for a just-accepted delivery's row, which its deliver job writes a moment after ingest
   * answers. Resolves false if it hasn't appeared within `timeoutMs` (a backlog, say).
   */
  async waitForDeliveryRow(deliveryId: string, timeoutMs: number): Promise<boolean> {
    this.#assertEnabled();
    const where = deliveryKey(deliveryId, WebhookDeliveryId.parseTimestamp(deliveryId));
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const row = await this.prisma.webhookDelivery.findFirst({ where, select: { id: true } });
      if (row) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Whether a delivery has a deliver job waiting on its endpoint's queue. */
  async isDeliveryQueued(delivery: { id: string; environmentId: string; endpointId: string }) {
    this.#assertEnabled();
    return this.jobQueue.isQueued({
      id: `webhook-delivery:${delivery.id}`,
      environmentId: delivery.environmentId,
      endpointId: delivery.endpointId,
    });
  }

  async quit() {
    if (this.options.disabled) return;
    this.logger.info("Shutting down webhook engine");
    clearInterval(this.partitionCoverageTimer);

    try {
      this.memoryGuard?.stop();
      await this.jobQueue.close();
      await this.waiterStore.quit();
      this.logger.info("Webhook engine worker stopped successfully");
    } catch (error) {
      this.logger.error("Error stopping webhook engine worker", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

// The provider retry window: idempotencyKeyExpiresAt = now + this. Must exceed the
// longest provider retry horizon so a late retry still hits the durable gate.
function resolveRetryWindowSeconds(endpoint: { source: string }): number {
  const DAY = 24 * 60 * 60;
  switch (endpoint.source) {
    case "stripe":
      return 3 * DAY;
    case "github":
      return 1 * DAY;
    default:
      return 1 * DAY;
  }
}

const DROP_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
const HEADERS_CAP_BYTES = 4 * 1024;

// Curate the headers stored on the delivery row (and thus surfaced to onEvent): drop credential
// headers + any scheme secret-bearing header, and bound the total size.
/**
 * The headers stored on a delivery. Headers named in `keep` (the ones live waiters match on) are
 * always stored, since a waiter can only match what was stored; the request's total header size
 * bounds them. The rest fill HEADERS_CAP_BYTES smallest first, so short ids and event types survive
 * a request padded with large headers. The stored object keeps the request's order.
 */
function capHeaders(
  headers: Record<string, string>,
  secretHeader?: string,
  keep?: Set<string>
): Record<string, string> {
  const drop = secretHeader ? new Set([...DROP_HEADERS, secretHeader.toLowerCase()]) : DROP_HEADERS;
  const entries = Object.entries(headers)
    .filter(([key]) => !drop.has(key.toLowerCase()))
    .map(([key, value], order) => ({
      key,
      value,
      order,
      bytes: key.length + (typeof value === "string" ? value.length : 0) + 4,
      kept: keep?.has(key.toLowerCase()) ?? false,
    }));
  const chosen = new Set<number>();
  let bytes = 0;
  for (const entry of entries) {
    if (entry.kept) chosen.add(entry.order);
  }
  for (const entry of [...entries].filter((e) => !e.kept).sort((a, b) => a.bytes - b.bytes)) {
    if (bytes + entry.bytes > HEADERS_CAP_BYTES) continue;
    chosen.add(entry.order);
    bytes += entry.bytes;
  }
  const out: Record<string, string> = {};
  for (const entry of entries) if (chosen.has(entry.order)) out[entry.key] = entry.value;
  return out;
}

function deriveSimulateIdempotencyKey(
  artifact: WebhookVerifierArtifact,
  input: IngestInput
): string {
  const idempotencyField = "config" in artifact ? artifact.config.idempotencyField : undefined;
  const lowerHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) lowerHeaders[key.toLowerCase()] = value;
  return deriveIdempotencyKey({
    idempotencyField,
    headers: lowerHeaders,
    rawBytes: input.rawBytes,
    timestampValue: "",
    signatureValue: "simulate",
  });
}

/**
 * The verified event stored on the delivery row. This is the only durable copy of the event: it is
 * routed as the run payload (task + session) and re-used on replay, so it is stored in full and the
 * ingress body-size limit bounds it. The dashboard caps it for display, not here. Every caller passes
 * a value produced by `JSON.parse`, so it is always serializable.
 */
function toStorableEvent(event: unknown): Prisma.InputJsonValue | undefined {
  if (event === undefined || event === null) return undefined;
  return event as Prisma.InputJsonValue;
}

type PortResult = {
  success: boolean;
  runId?: string;
  error?: string;
  errorType?: WebhookDeliverTaskErrorType;
  skipped?: boolean;
  skippedReason?: string;
};

function outcomeFromPortResult(result: PortResult): TargetOutcome {
  if (result.skipped) {
    return {
      kind: "skipped",
      reason: result.skippedReason ?? "startOn: not a session-start event",
    };
  }
  if (result.success) return { kind: "succeeded", runId: result.runId };
  if (result.errorType === "INFRASTRUCTURE") return { kind: "transient", infrastructure: true };
  if (result.errorType === "QUEUE_LIMIT" || result.errorType === "SYSTEM_ERROR") {
    return { kind: "transient", error: result.error ?? "webhook.deliver transient failure" };
  }
  return { kind: "failed", error: result.error ?? "webhook.deliver failed" };
}

function applyTargetOutcome(
  result: WebhookDeliveryTargetResult,
  outcome: TargetOutcome,
  isFinalAttempt: boolean
): WebhookDeliveryTargetResult {
  const base = {
    id: result.id,
    type: result.type,
    ...(result.deliverAs ? { deliverAs: result.deliverAs } : {}),
    ...(result.taskId ? { taskId: result.taskId } : {}),
  };
  switch (outcome.kind) {
    case "succeeded":
      return { ...base, status: "SUCCEEDED", ...(outcome.runId ? { runId: outcome.runId } : {}) };
    case "skipped":
      return { ...base, status: "FILTERED", reason: outcome.reason };
    case "failed":
      return { ...base, status: "FAILED", error: outcome.error };
    case "transient":
      return {
        ...base,
        status: isFinalAttempt ? "FAILED" : "PENDING",
        ...(outcome.error ? { error: outcome.error } : {}),
      };
  }
}

/** A target result's identity: its id, type and, for a session target, how it delivers. */
function targetBase(
  target: WebhookRoutingTarget
): Pick<WebhookDeliveryTargetResult, "id" | "type" | "deliverAs"> {
  return target.type === "session"
    ? { id: target.id, type: target.type, deliverAs: target.deliverAs }
    : { id: target.id, type: target.type };
}

/** The subscriber a replay would run, as the caller's authorization sees it. */
function replaySubscriber(target: WebhookRoutingTarget): ReplaySubscriber {
  return target.type === "task"
    ? { id: target.id, type: "task", taskId: target.taskId }
    : { id: target.id, type: "session", taskId: target.taskIdentifier };
}

function describeTargetErrors(results: WebhookDeliveryTargetResult[]): string {
  return results.map((result) => `${result.id}: ${result.error ?? "failed"}`).join("; ");
}

function waiterLimitMessage(reason: string, limits: WebhookWaiterLimits): string {
  switch (reason) {
    case "environment_limit":
      return `the environment already has ${limits.perEnvironment} live waiters`;
    case "endpoint_limit":
      return `the endpoint already has ${limits.perEndpoint} live waiters`;
    case "shape_limit":
      return `the endpoint already has ${limits.shapes} live match shapes`;
    default:
      return "a webhook waiter limit was reached";
  }
}

/** The delivery's one waiter entry: PENDING while claimed waiters are unresolved, then SUCCEEDED or FAILED. */
function waiterSummary(counts: ClaimCounts, lastError?: string): WebhookDeliveryTargetResult {
  const error = counts.error ?? lastError;
  const status =
    counts.remaining > 0 ? "PENDING" : counts.failed > 0 ? "FAILED" : ("SUCCEEDED" as const);
  const detail =
    status === "FAILED"
      ? `${counts.failed} of ${counts.claimed} waiters could not be resumed${error ? `: ${error}` : ""}`
      : status === "PENDING"
        ? error
        : undefined;
  return {
    id: "waiters",
    type: "waiter",
    status,
    waiters: {
      matched: counts.claimed,
      resumed: counts.claimed - counts.remaining - counts.failed,
      failed: counts.failed,
    },
    ...(detail ? { error: detail } : {}),
  };
}

/** Which completion chunk a claimed waiter belongs to (FNV-1a), stable across jobs and attempts. */
function waiterChunk(id: string, chunks: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % chunks;
}
