import type { Counter, Histogram, Meter, Tracer } from "@internal/tracing";
import { getMeter, getTracer, startSpan } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import type {
  Prisma,
  WebhookDatabase,
  WebhookDelivery,
  WebhookEndpoint,
} from "@trigger.dev/database";
import { Worker, type JobHandlerParams } from "@trigger.dev/redis-worker";
import type { Redis } from "@internal/redis";
import { createRedisClient } from "@internal/redis";
import { FilterAst, WebhookVerifierArtifact } from "@trigger.dev/core/v3";
import type { WebhookRoutingTarget } from "@trigger.dev/core/v3";
import { WebhookDeliveryId } from "@trigger.dev/core/v3/isomorphic";
import { webhookWorkerCatalog } from "./workerCatalog.js";
import { ensurePartitions } from "./partitions.js";
import { type CachedEndpoint, TtlCache } from "./cache.js";
import { evaluateFilter, parseFilter } from "./filter/index.js";
import { verify } from "./verification/index.js";
import { sha256Hex } from "./verification/util.js";
import { deriveIdempotencyKey, tryParseJson } from "./verification/derive.js";
import type {
  IngestInput,
  IngestResult,
  ReplayResult,
  TriggerWebhookTaskCallback,
  WebhookDeliverTaskErrorType,
  WebhookEngineOptions,
} from "./types.js";
import { evaluateSessionKeyTemplate, walkPath as resolveBodyPath } from "./sessionKey.js";

// The deliver job's retry budget (redis-worker DLQs after this many attempts).
const WEBHOOK_DELIVER_MAX_ATTEMPTS = webhookWorkerCatalog["webhook.deliver"].retry.maxAttempts;

export class WebhookEngine {
  private worker!: Worker<typeof webhookWorkerCatalog>;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;

  private deliveryEnqueueCounter: Counter;
  private deliveryFilteredCounter: Counter;
  private deliveryExecutionCounter: Counter;
  private deliveryExecutionDuration: Histogram;
  private deliveryExecutionFailureCounter: Counter;
  private ensurePartitionsCounter: Counter;
  private endpointCacheCounter: Counter;

  prisma: WebhookDatabase;

  private triggerTask: TriggerWebhookTaskCallback;
  private frontGate!: Redis;
  // Caches the endpoint + resolved signing secret per opaqueId so the ingest hot path skips two
  // Postgres reads (endpoint lookup + secret decrypt). Both are immutable per endpoint within the
  // TTL; a status change or secret rotation takes effect after at most the TTL.
  private endpointCache: TtlCache<CachedEndpoint>;

  constructor(private readonly options: WebhookEngineOptions) {
    this.logger =
      options.logger ?? new Logger("WebhookEngine", (this.options.logLevel ?? "info") as any);
    this.prisma = options.prisma;
    this.triggerTask = options.triggerTask;

    this.tracer = options.tracer ?? getTracer("webhook-engine");
    this.meter = options.meter ?? getMeter("webhook-engine");

    this.deliveryEnqueueCounter = this.meter.createCounter("webhook_delivery_enqueues_total", {
      description: "Total number of webhook deliveries enqueued for routing",
    });
    this.deliveryFilteredCounter = this.meter.createCounter("webhook_delivery_filtered_total", {
      description:
        "Total number of webhook deliveries received but not routed due to the endpoint filter",
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
    this.endpointCacheCounter = this.meter.createCounter("webhook_endpoint_cache_total", {
      description: "Endpoint+secret cache lookups on the ingest hot path, by result (hit/miss)",
    });

    this.endpointCache = new TtlCache<CachedEndpoint>(
      options.endpointCache?.ttlMs ?? 30_000,
      options.endpointCache?.maxSize ?? 10_000
    );

    if (options.disabled) {
      this.logger.info("Webhook engine disabled; skipping Redis and worker setup");
      return;
    }

    this.frontGate = createRedisClient(options.redis);

    this.worker = new Worker({
      name: "webhook-engine-worker",
      redisOptions: {
        ...options.redis,
        keyPrefix: `${options.redis.keyPrefix ?? ""}webhook:`,
      },
      catalog: {
        ...webhookWorkerCatalog,
        ensurePartitions: {
          ...webhookWorkerCatalog.ensurePartitions,
          cron: options.partitions?.ensureSchedule ?? webhookWorkerCatalog.ensurePartitions.cron,
          jitterInMs:
            options.partitions?.ensureJitterInMs ??
            webhookWorkerCatalog.ensurePartitions.jitterInMs,
        },
      },
      concurrency: {
        limit: options.worker.concurrency,
        workers: options.worker.workers,
        tasksPerWorker: options.worker.tasksPerWorker,
      },
      pollIntervalMs: options.worker.pollIntervalMs,
      shutdownTimeoutMs: options.worker.shutdownTimeoutMs,
      logger: new Logger("WebhookEngineWorker", (options.logLevel ?? "info") as any),
      jobs: {
        "webhook.deliver": this.#handleDeliverJob.bind(this),
        ensurePartitions: this.#handleEnsurePartitionsJob.bind(this),
      },
    });

    if (!options.worker.disabled) {
      this.worker.start();
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
    return startSpan(this.tracer, "webhook.ingest", async (span) => {
      span.setAttribute("opaqueId", input.opaqueId);

      // 1+2. Resolve the endpoint + signing secret (cached per opaqueId). Fail-closed outcomes
      // (not found / inactive / secret missing) are never cached, so verify only ever runs with a
      // non-empty secret.
      const resolved = await this.#resolveEndpoint(input.opaqueId);
      if (!resolved.ok) return resolved.result;
      const { endpoint, secret } = resolved;

      // 3. Verify inline. safeParse the Json artifact so a corrupt row is a 400, not a 5xx storm.
      const parsedArtifact = WebhookVerifierArtifact.safeParse(endpoint.verifierArtifact);
      if (!parsedArtifact.success) {
        return { outcome: "verification_failed", error: "corrupt verifier artifact" };
      }
      const verdict = verify(parsedArtifact.data, {
        rawBytes: input.rawBytes,
        headers: input.headers,
        url: input.url,
        secret,
      });
      if (!verdict.ok) {
        return { outcome: "verification_failed", error: verdict.error ?? "invalid" };
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
            body: String(resolveBodyPath(event, handshake.respondPath) ?? ""),
          };
        }
      }

      return this.#recordAndRoute({
        endpoint,
        artifact: parsedArtifact.data,
        filterAst: resolved.filterAst,
        parsedEvent: verdict.parsedEvent,
        idempotencyKey: verdict.idempotencyKey,
        errorMessage: verdict.error ?? null,
        rawBytes: input.rawBytes,
        headers: input.headers,
      });
    });
  }

  /**
   * Shared post-verify path for ingest() and simulateInject(): the atomic Redis front gate (dedupe),
   * the filter gate, the append-only delivery row, and the routing enqueue. The front gate is
   * two-phase (claim with a short lock via SET NX, then promote to the full dedupe window once the
   * job is durably enqueued) so it is both atomic and crash-safe: a crash mid-ingest releases the
   * short lock instead of suppressing the provider's retry, and the Run Engine idempotencyKey gate
   * is the durable exactly-once guard. A filtered delivery is still recorded (for visibility) but not
   * routed.
   */
  async #recordAndRoute(args: {
    endpoint: WebhookEndpoint;
    artifact: WebhookVerifierArtifact;
    filterAst: FilterAst | null;
    parsedEvent: unknown;
    idempotencyKey: string;
    errorMessage: string | null;
    rawBytes: Uint8Array;
    headers: Record<string, string>;
  }): Promise<IngestResult> {
    const {
      endpoint,
      artifact,
      filterAst,
      parsedEvent,
      idempotencyKey,
      errorMessage,
      rawBytes,
      headers,
    } = args;

    const secretHeader =
      "config" in artifact &&
      artifact.config.scheme === "shared-secret" &&
      artifact.config.placement === "header"
        ? artifact.config.fieldName
        : undefined;

    const gateKey = `webhookdedupe:${endpoint.id}:${idempotencyKey}`;
    const { id, friendlyId, timestamp: createdAt } = WebhookDeliveryId.generate();

    const claimed = await this.frontGate.set(
      gateKey,
      friendlyId,
      "EX",
      this.#frontGateClaimTtlSeconds(),
      "NX"
    );
    if (claimed !== "OK") {
      const existing = await this.frontGate.get(gateKey);
      return { outcome: "duplicate", deliveryId: existing ?? undefined };
    }

    const { filtered, reason } = this.#evaluateFilter(
      filterAst,
      parsedEvent,
      headers,
      endpoint,
      idempotencyKey
    );

    const isTest = Object.entries(headers).some(
      ([key, value]) => key.toLowerCase() === "x-trigger-test" && Boolean(value)
    );

    let rowCreated = false;
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          id,
          friendlyId,
          createdAt,
          webhookEndpointId: endpoint.id,
          organizationId: endpoint.organizationId,
          projectId: endpoint.projectId,
          runtimeEnvironmentId: endpoint.runtimeEnvironmentId,
          environmentType: endpoint.environmentType,
          externalDeliveryId: idempotencyKey,
          idempotencyKey,
          status: filtered ? "FILTERED" : "PENDING",
          isTest,
          parsedEvent: toStorableEvent(parsedEvent),
          headers: capHeaders(headers, secretHeader),
          rawBodyHash: sha256Hex(rawBytes),
          errorMessage,
          filterReason: reason,
        },
      });
      rowCreated = true;

      if (filtered) {
        this.deliveryFilteredCounter.add(1);
      } else {
        this.deliveryEnqueueCounter.add(1);
        await this.worker.enqueueOnce({
          id: `webhook-delivery:${id}`,
          job: "webhook.deliver",
          payload: { deliveryId: id, createdAt },
        });
      }
    } catch (error) {
      await this.frontGate.del(gateKey).catch(() => {});
      if (rowCreated) {
        await this.prisma.webhookDelivery
          .update({
            where: { id_createdAt: { id, createdAt } },
            data: { status: "FAILED", errorMessage: String(error), processedAt: new Date() },
          })
          .catch(() => {});
      }
      return { outcome: "enqueue_failed", error: String(error) };
    }

    await this.frontGate
      .set(gateKey, friendlyId, "EX", this.#frontGateTtlSeconds(artifact))
      .catch(() => {});

    return { outcome: "accepted", deliveryId: id, deliveryFriendlyId: friendlyId };
  }

  /**
   * Inject a delivery WITHOUT signature verification, then run the same filter + record + route path
   * as ingest(). This is the test-console "simulate" mode for endpoints we cannot sign for
   * (asymmetric public-key schemes; url-secret path placement). The body must be JSON. Everything
   * downstream (filter, startOn, routing, run/session) runs for real.
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

      const parsed = tryParseJson(input.rawBytes);
      if (parsed.error || parsed.parsedEvent === undefined) {
        return { outcome: "verification_failed", error: parsed.error ?? "body is not valid JSON" };
      }

      return this.#recordAndRoute({
        endpoint,
        artifact: parsedArtifact.data,
        filterAst: this.#parseStoredFilter(endpoint),
        parsedEvent: parsed.parsedEvent,
        idempotencyKey: deriveSimulateIdempotencyKey(parsedArtifact.data, input),
        errorMessage: null,
        rawBytes: input.rawBytes,
        headers: input.headers,
      });
    });
  }

  // PUBLIC: re-run a past delivery's task from its stored event. We don't keep the raw body, so this
  // re-triggers from the captured parsedEvent + headers (not a re-verify). A NEW delivery row with a
  // fresh idempotency key is created so the run actually executes (not deduped) and the replay is
  // auditable; it shares the original externalDeliveryId so the two group together.
  async replayDelivery(input: { id: string; createdAt: Date }): Promise<ReplayResult> {
    this.#assertEnabled();
    return startSpan(this.tracer, "webhook.replay", async (span) => {
      span.setAttribute("deliveryId", input.id);

      const original = await this.prisma.webhookDelivery.findFirst({
        where: { id: input.id, createdAt: input.createdAt },
      });
      if (!original) return { outcome: "delivery_not_found" };

      const endpoint = await this.prisma.webhookEndpoint.findFirst({
        where: { id: original.webhookEndpointId },
      });
      if (!endpoint) return { outcome: "endpoint_not_found" };
      if ((endpoint.routingTarget as WebhookRoutingTarget).type !== "task") {
        return { outcome: "unsupported_target" };
      }

      const { id, friendlyId, timestamp: createdAt } = WebhookDeliveryId.generate();

      await this.prisma.webhookDelivery.create({
        data: {
          id,
          friendlyId,
          createdAt,
          webhookEndpointId: original.webhookEndpointId,
          organizationId: original.organizationId,
          projectId: original.projectId,
          runtimeEnvironmentId: original.runtimeEnvironmentId,
          environmentType: original.environmentType,
          externalDeliveryId: original.externalDeliveryId, // groups with the original
          idempotencyKey: `replay:${id}`, // unique -> the Run Engine runs it, not dedupes
          status: "PENDING",
          parsedEvent: (original.parsedEvent ?? undefined) as Prisma.InputJsonValue | undefined,
          headers: (original.headers ?? undefined) as Prisma.InputJsonValue | undefined,
          rawBodyHash: original.rawBodyHash,
        },
      });
      this.deliveryEnqueueCounter.add(1);

      await this.worker.enqueueOnce({
        id: `webhook-delivery:${id}`,
        job: "webhook.deliver",
        payload: { deliveryId: id, createdAt },
      });

      return { outcome: "replayed", deliveryId: id, deliveryFriendlyId: friendlyId };
    });
  }

  // Resolve the endpoint + plaintext signing secret for an opaqueId, cached. Only fully-resolved
  // (ACTIVE + secret present) endpoints are cached; fail-closed outcomes always re-read.
  async #resolveEndpoint(
    opaqueId: string
  ): Promise<
    | { ok: true; endpoint: WebhookEndpoint; secret: string; filterAst: FilterAst | null }
    | { ok: false; result: IngestResult }
  > {
    const cached = this.endpointCache.get(opaqueId);
    if (cached) {
      this.endpointCacheCounter.add(1, { result: "hit" });
      return {
        ok: true,
        endpoint: cached.endpoint,
        secret: cached.secret,
        filterAst: cached.filterAst,
      };
    }
    this.endpointCacheCounter.add(1, { result: "miss" });

    // Single-row via the global @unique on opaqueId (Q2).
    const endpoint = await this.prisma.webhookEndpoint.findFirst({ where: { opaqueId } });
    if (!endpoint) return { ok: false, result: { outcome: "endpoint_not_found" } };
    if (endpoint.status !== "ACTIVE")
      return { ok: false, result: { outcome: "endpoint_inactive" } };

    // Injected port keeps the engine SecretStore-free.
    const secret = endpoint.signingSecretKey
      ? await this.options.resolveSigningSecret(endpoint.signingSecretKey)
      : undefined;
    if (!secret) return { ok: false, result: { outcome: "secret_missing" } };

    // Parse the stored AST once per cache load. A corrupt AST fails open (route all) rather than
    // blocking delivery — a filter bug must never silently swallow real webhooks.
    const filterAst = this.#parseStoredFilter(endpoint);

    this.endpointCache.set(opaqueId, { endpoint, secret, filterAst });
    return { ok: true, endpoint, secret, filterAst };
  }

  #parseStoredFilter(endpoint: WebhookEndpoint): FilterAst | null {
    if (endpoint.filterAst == null) return null;
    const parsed = FilterAst.safeParse(endpoint.filterAst);
    if (!parsed.success) {
      this.logger.warn("webhook: corrupt filterAst, routing all", { endpointId: endpoint.id });
      return null;
    }
    return parsed.data;
  }

  // Evaluate the endpoint filter (if any) against the verified delivery. Fail-open: an evaluation
  // error routes the delivery (never drops a real webhook) and is logged.
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
          id: endpoint.handlerWebhookId,
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
          id: endpoint.handlerWebhookId,
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

  // Short "processing lock" TTL held between the atomic claim and the promote-to-full-window. Keep
  // it well above the create+enqueue latency (ms) but short enough that a crash mid-ingest releases
  // the key long before a provider's retry, so events are re-processed rather than dropped.
  #frontGateClaimTtlSeconds(): number {
    return this.options.frontGate?.claimTtlSeconds ?? 60;
  }

  // webhook.deliver handler: load delivery + endpoint, route to the task via the
  // injected port, mark terminal. Run Engine idempotency is the durable dedupe gate.
  async #handleDeliverJob({
    payload,
    attempt,
  }: JobHandlerParams<typeof webhookWorkerCatalog, "webhook.deliver">) {
    return startSpan(this.tracer, "webhook.deliver", async (span) => {
      span.setAttribute("deliveryId", payload.deliveryId);
      this.deliveryExecutionCounter.add(1);
      const start = performance.now();

      // 1. Load by composite PK. (id, createdAt) prunes to exactly one partition.
      const delivery = await this.prisma.webhookDelivery.findFirst({
        where: { id: payload.deliveryId, createdAt: payload.createdAt },
      });
      if (!delivery) {
        this.logger.error("webhook.deliver: delivery not found", {
          deliveryId: payload.deliveryId,
        });
        return; // terminal; nothing to retry
      }

      if (delivery.status === "SUCCEEDED" || delivery.status === "FAILED") {
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

      // 2. Mark PROCESSING (best-effort).
      await this.prisma.webhookDelivery.update({
        where: { id_createdAt: { id: delivery.id, createdAt: delivery.createdAt } },
        data: { status: "PROCESSING" },
      });

      // 3. Resolve route.
      const routingTarget = endpoint.routingTarget as WebhookRoutingTarget;

      if (routingTarget.type === "session") {
        await this.#deliverToSession(delivery, endpoint, routingTarget, start, attempt);
        return;
      }
      if (routingTarget.type !== "task") {
        await this.#markFailed(
          delivery,
          `Unsupported routing target: ${(routingTarget as { type: string }).type}`
        );
        return;
      }

      // 4. Call the injected triggerTask port.
      const identityTags = [
        `webhook:endpoint:${endpoint.id}`,
        `webhook:source:${endpoint.source}`,
        ...(endpoint.endpointTenantId ? [`webhook:tenant:${endpoint.endpointTenantId}`] : []),
      ];

      const result = await this.options.triggerTask({
        environmentId: delivery.runtimeEnvironmentId,
        taskId: routingTarget.taskId,
        idempotencyKey: `${endpoint.id}:${delivery.idempotencyKey}`,
        idempotencyKeyExpiresAt: this.#retryWindowExpiry(endpoint),
        payload: delivery.parsedEvent,
        headers: (delivery.headers as Record<string, string> | null) ?? {},
        identityTags,
        endpointMetadata: endpoint.metadata,
      });

      await this.#applyDeliverResult(delivery, result, start, attempt);
    });
  }

  // Route a verified delivery to a session: resolve the key template to the session externalId, then
  // hand off to the injected deliverToSession port (find-or-create the session, append the action).
  async #deliverToSession(
    delivery: WebhookDelivery,
    endpoint: WebhookEndpoint,
    routingTarget: Extract<WebhookRoutingTarget, { type: "session" }>,
    start: number,
    attempt: number
  ) {
    if (!this.options.deliverToSession) {
      await this.#markFailed(delivery, "Session delivery is not configured");
      return;
    }

    const externalId = evaluateSessionKeyTemplate(routingTarget.keyTemplate, {
      body: delivery.parsedEvent,
      webhook: {
        externalRef: endpoint.endpointExternalRef ?? "",
        tenantId: endpoint.endpointTenantId ?? "",
        id: endpoint.handlerWebhookId,
        source: endpoint.source,
        deliveryId: delivery.externalDeliveryId,
      },
      header: (delivery.headers as Record<string, string> | null) ?? {},
    });
    if (!externalId) {
      await this.#markFailed(delivery, `Session key resolved empty: ${routingTarget.keyTemplate}`);
      return;
    }

    const isSessionStart = this.#evaluateSessionStart(routingTarget.startOn, delivery, endpoint);

    const result = await this.options.deliverToSession({
      environmentId: delivery.runtimeEnvironmentId,
      taskIdentifier: routingTarget.taskIdentifier,
      externalId,
      deliverAs: routingTarget.deliverAs,
      actionType: routingTarget.actionType,
      connectorId: routingTarget.connectorId,
      event: delivery.parsedEvent,
      source: endpoint.source,
      headers: (delivery.headers as Record<string, string> | null) ?? {},
      deliveryId: delivery.externalDeliveryId,
      triggerConfigTemplate: routingTarget.triggerConfigTemplate,
      idempotencyKey: delivery.idempotencyKey,
      isSessionStart,
    });

    await this.#applyDeliverResult(delivery, result, start, attempt);
  }

  // Mark a delivery terminal from a port result. Shared by the task and session paths: success ->
  // SUCCEEDED (+runId); a transient error resets to PENDING and throws so redis-worker retries, EXCEPT
  // on the final attempt where it's marked FAILED (throwing there would DLQ the job and leave the
  // delivery stuck PENDING); any other error -> FAILED.
  async #applyDeliverResult(
    delivery: WebhookDelivery,
    result: {
      success: boolean;
      runId?: string;
      error?: string;
      errorType?: WebhookDeliverTaskErrorType;
      skipped?: boolean;
      skippedReason?: string;
    },
    start: number,
    attempt: number
  ) {
    this.deliveryExecutionDuration.record(performance.now() - start);

    if (result.skipped) {
      // Resume-only and no session existed: terminal + visible, but nothing routed (no run, no egress).
      await this.prisma.webhookDelivery.update({
        where: { id_createdAt: { id: delivery.id, createdAt: delivery.createdAt } },
        data: {
          status: "FILTERED",
          filterReason: result.skippedReason ?? "startOn: not a session-start event",
          processedAt: new Date(),
        },
      });
    } else if (result.success) {
      await this.prisma.webhookDelivery.update({
        where: { id_createdAt: { id: delivery.id, createdAt: delivery.createdAt } },
        data: { status: "SUCCEEDED", runId: result.runId ?? null, processedAt: new Date() },
      });
    } else if (result.errorType === "QUEUE_LIMIT" || result.errorType === "SYSTEM_ERROR") {
      if (attempt >= WEBHOOK_DELIVER_MAX_ATTEMPTS - 1) {
        await this.#markFailed(
          delivery,
          result.error ?? "webhook.deliver failed after max attempts"
        );
        return;
      }
      await this.prisma.webhookDelivery.update({
        where: { id_createdAt: { id: delivery.id, createdAt: delivery.createdAt } },
        data: { status: "PENDING", errorMessage: result.error ?? null },
      });
      this.deliveryExecutionFailureCounter.add(1);
      throw new Error(result.error ?? "webhook.deliver transient failure");
    } else {
      await this.#markFailed(delivery, result.error ?? "webhook.deliver failed");
    }
  }

  async #markFailed(delivery: WebhookDelivery, message: string) {
    this.deliveryExecutionFailureCounter.add(1);
    await this.prisma.webhookDelivery.update({
      where: { id_createdAt: { id: delivery.id, createdAt: delivery.createdAt } },
      data: { status: "FAILED", errorMessage: message, processedAt: new Date() },
    });
  }

  #retryWindowExpiry(endpoint: WebhookEndpoint): Date {
    return new Date(Date.now() + resolveRetryWindowSeconds(endpoint) * 1000);
  }

  // ensurePartitions cron handler. Pre-creates dated partitions ahead + drops cold ones.
  async #handleEnsurePartitionsJob(
    _job: JobHandlerParams<typeof webhookWorkerCatalog, "ensurePartitions">
  ) {
    return startSpan(this.tracer, "ensurePartitions", async (span) => {
      this.ensurePartitionsCounter.add(1);
      const result = await ensurePartitions(this.prisma, {
        now: new Date(),
        lookaheadDays: this.options.partitions?.lookaheadDays ?? 10, // 7..14
        retentionDays: this.options.partitions?.retentionDays ?? 7,
      });
      span.setAttribute("created", result.created.length);
      span.setAttribute("dropped", result.dropped.length);
      span.setAttribute("deferred", result.deferred.length);
      this.logger.info("webhook ensurePartitions", result);
    });
  }

  async getJob(id: string) {
    this.#assertEnabled();
    return this.worker.getJob(id);
  }

  async quit() {
    if (this.options.disabled) return;
    this.logger.info("Shutting down webhook engine");

    try {
      await this.worker.stop();
      await this.frontGate.quit();
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
function capHeaders(headers: Record<string, string>, secretHeader?: string): Prisma.InputJsonValue {
  const drop = secretHeader ? new Set([...DROP_HEADERS, secretHeader.toLowerCase()]) : DROP_HEADERS;
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(headers)) {
    if (drop.has(key.toLowerCase())) continue;
    const entryBytes = key.length + (typeof value === "string" ? value.length : 0) + 4;
    if (bytes + entryBytes > HEADERS_CAP_BYTES) continue;
    out[key] = value;
    bytes += entryBytes;
  }
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
 * ingress body-size limit bounds it. The dashboard caps it for display, not here. Returns undefined
 * only when the event cannot be serialized (never for a JSON-parsed body), which keeps a
 * non-serializable value from failing the whole delivery.
 */
function toStorableEvent(event: unknown): Prisma.InputJsonValue | undefined {
  if (event === undefined || event === null) return undefined;
  try {
    JSON.stringify(event);
    return event as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}
