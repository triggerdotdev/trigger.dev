import { randomUUID } from "node:crypto";
import type { Logger } from "@trigger.dev/core/logger";
import type { RedisClient } from "@internal/redis";
import {
  createFairQueueRedisClient,
  DRRScheduler,
  ExponentialBackoffRetry,
  FairQueue,
  TenantShardedFairQueueKeyProducer,
  WorkerQueueManager,
  type FairQueueRedisOptions,
  type RetryStrategy,
} from "@trigger.dev/redis-worker";
import {
  context,
  getMeter,
  propagation,
  ROOT_CONTEXT,
  type Counter,
  type Histogram,
  type Meter,
  type Tracer,
} from "@internal/tracing";
import { z } from "zod";
import { isInfrastructureError } from "./errors.js";

/** The delivery row a deliver job writes before it routes: ingest acknowledges with only the job queued. */
export const DeliveryRecord = z.object({
  friendlyId: z.string(),
  retentionDays: z.number().int(),
  webhookEndpointId: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  runtimeEnvironmentId: z.string(),
  environmentType: z.string(),
  externalDeliveryId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(["PENDING", "FILTERED"]),
  isTest: z.boolean(),
  parsedEvent: z.unknown(),
  headers: z.record(z.string(), z.string()).nullable(),
  rawBodyHash: z.string().nullable(),
  errorMessage: z.string().nullable(),
  filterReason: z.string().nullable(),
  targets: z.array(z.unknown()),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

export const DeliverJobPayload = z.object({
  deliveryId: z.string(),
  createdAt: z.coerce.date(),
  arrivedAt: z.number().optional(),
  liveWaiters: z.boolean().optional(),
  waiterId: z.string().optional(),
  record: DeliveryRecord,
});
export type DeliverJobPayload = z.infer<typeof DeliverJobPayload>;

export const CompleteWaitersJobPayload = z.object({
  deliveryId: z.string(),
  createdAt: z.coerce.date(),
  chunk: z.number().int().nonnegative(),
  chunks: z.number().int().positive(),
});
export type CompleteWaitersJobPayload = z.infer<typeof CompleteWaitersJobPayload>;

/** The W3C trace context a job was enqueued under, so its run continues the ingest's trace. */
const TraceCarrier = z.record(z.string(), z.string());

const DeliverJob = z.object({
  job: z.literal("webhook.deliver"),
  payload: DeliverJobPayload,
  traceContext: TraceCarrier.optional(),
});
const CompleteWaitersJob = z.object({
  job: z.literal("webhook.completeWaiters"),
  payload: CompleteWaitersJobPayload,
  traceContext: TraceCarrier.optional(),
});
const RoutedWebhookJob = z.discriminatedUnion("job", [DeliverJob, CompleteWaitersJob]);
/** A delivery or waiter completion job. */
export type WebhookJob = z.infer<typeof RoutedWebhookJob>;

/**
 * Records a job that ran out of attempts, queued when the exhausted handler couldn't run at the
 * time (its database being down too, say). It retries like any job, then requeues itself, until it
 * lands or `EXHAUSTED_RECORD_MAX_AGE_MS` passes.
 */
const ExhaustedJob = z.object({
  job: z.literal("webhook.exhausted"),
  payload: z.object({
    job: RoutedWebhookJob,
    error: z.string(),
    origin: z.string(),
    generation: z.number().int().nonnegative(),
    firstFailedAt: z.number(),
  }),
  traceContext: TraceCarrier.optional(),
});
const QueuedWebhookJob = z.discriminatedUnion("job", [
  DeliverJob,
  CompleteWaitersJob,
  ExhaustedJob,
]);
type QueuedWebhookJob = z.infer<typeof QueuedWebhookJob>;

/** Attempts per job, the first included. */
export const WEBHOOK_JOB_MAX_ATTEMPTS = 5;

const EXHAUSTED_RECORD_DELAY_MS = 30_000;
const EXHAUSTED_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const WORKER_QUEUE_ID = "webhook-jobs";

/**
 * Shards of the job queue. An environment's jobs all live on one, `jumpHash(environmentId, 16)`,
 * under the hash tag `{webhook-jobs:<shard>}`, so every queue script stays in one cluster slot.
 * Changing it moves every key, so it is fixed.
 */
const WEBHOOK_JOB_SHARDS = 16;

/** The longest wait between attempts of a job failing on our infrastructure. */
const INFRASTRUCTURE_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Backoff between attempts. A failure of our infrastructure retries with capped backoff for as long
 * as it lasts; anything else gets `WEBHOOK_JOB_MAX_ATTEMPTS` attempts.
 */
class WebhookJobRetry implements RetryStrategy {
  readonly maxAttempts = WEBHOOK_JOB_MAX_ATTEMPTS;
  private readonly backoff: ExponentialBackoffRetry;

  constructor(private readonly baseDelayMs: number) {
    this.backoff = new ExponentialBackoffRetry({
      maxAttempts: WEBHOOK_JOB_MAX_ATTEMPTS,
      minTimeoutInMs: baseDelayMs,
      maxTimeoutInMs: 30 * baseDelayMs,
      factor: 2,
      randomize: true,
    });
  }

  getNextDelay(attempt: number, error?: Error): number | null {
    if (error && isInfrastructureError(error)) {
      const delay = Math.min(
        this.baseDelayMs * 2 ** Math.min(attempt - 1, 6),
        INFRASTRUCTURE_RETRY_MAX_DELAY_MS
      );
      return Math.round(delay * (0.5 + Math.random() * 0.5));
    }
    return this.backoff.getNextDelay(attempt, error);
  }
}

/** A job handler. `attempt` counts from 0; a throw retries with backoff until the last attempt. */
type JobHandler<T> = (params: { payload: T; attempt: number }) => Promise<void>;

export type WebhookJobQueueOptions = {
  redis: FairQueueRedisOptions;
  logger: Logger;
  tracer?: Tracer;
  meter?: Meter;
  /** Jobs this process runs at once. */
  consumers: number;
  /** Jobs one environment can have in flight at once, across every process, or a per-environment lookup. */
  tenantConcurrency: number | ((environmentId: string) => Promise<number>);
  /** How long an idle consumer waits before polling again, and the claim loop's interval. Default 100ms. */
  consumerIntervalMs?: number;
  /** DRR credits per tenant per round, and the most a tenant can bank. */
  quantum?: number;
  maxDeficit?: number;
  /** How many claimed jobs may wait in the shared worker queue before claiming pauses. */
  workerQueueMaxDepth?: number;
  /**
   * How long a running job's lease lasts without renewal, and how often expired leases are
   * reclaimed. A running job renews its lease every third of the timeout. Default 60s and 5s.
   */
  visibilityTimeoutMs?: number;
  reclaimIntervalMs?: number;
  /** How often a running job renews its lease. Default a third of the visibility timeout. */
  heartbeatIntervalMs?: number;
  /**
   * How long a run's ownership of a job outlives its last renewal. A reclaimed attempt starts only
   * once the previous run's ownership has lapsed. Default twice the visibility timeout.
   */
  ownerTtlMs?: number;
  /** How long a queued exhausted record waits before it runs. Default 30s. */
  exhaustedRecordDelayMs?: number;
  /** The first retry's backoff; later ones double from it. Default 1s. */
  retryBaseDelayMs?: number;
  /**
   * The most job payload bytes one environment may have queued or in flight. An enqueue past it
   * throws `TenantQueueFullError`. Absent or 0 means no limit.
   */
  environmentPayloadBytesLimit?: (environmentId: string) => Promise<number> | number;
  handlers: {
    deliver: JobHandler<DeliverJobPayload>;
    completeWaiters: JobHandler<CompleteWaitersJobPayload>;
    /**
     * Runs when a job throws on its last attempt, before the job is dropped. If it throws too, it's
     * run again later from a job of its own, so it must be safe to repeat.
     */
    exhausted?: (job: WebhookJob, error: Error) => Promise<void>;
  };
};

/**
 * The webhook engine's job queue: deliveries and waiter completion jobs on a FairQueue whose tenant
 * is the environment. Each endpoint is its own queue, tenants are served round robin (DRR), and one
 * environment can hold at most `tenantConcurrency` jobs in flight, so a burst on one tenant's
 * endpoints can't take the whole worker from everyone else.
 */
export class WebhookJobQueue {
  private readonly fairQueue: FairQueue<typeof QueuedWebhookJob>;
  private readonly workerQueue: WorkerQueueManager;
  private readonly keys: TenantShardedFairQueueKeyProducer;
  private readonly redis: RedisClient;
  private readonly queueTime: Histogram;
  private readonly runDuration: Histogram;
  private readonly exhaustedCounter: Counter;
  private readonly meter: Meter;
  private loops: Promise<void>[] = [];
  private running = false;
  private gaugesRegistered = false;

  constructor(private readonly options: WebhookJobQueueOptions) {
    this.keys = new TenantShardedFairQueueKeyProducer({
      prefix: "webhook-jobs",
      shardCount: WEBHOOK_JOB_SHARDS,
      extractTenantId: tenantOf,
      extractGroupId: (groupName, queueId) => (groupName === "tenant" ? tenantOf(queueId) : ""),
    });

    const scheduler = new DRRScheduler({
      redis: options.redis,
      keys: this.keys,
      quantum: options.quantum ?? 10,
      maxDeficit: options.maxDeficit ?? 50,
      logger: {
        debug: (message, context) => options.logger.debug(message, context),
        error: (message, context) => options.logger.error(message, context),
      },
    });

    this.fairQueue = new FairQueue({
      redis: options.redis,
      keys: this.keys,
      scheduler,
      payloadSchema: QueuedWebhookJob,
      validateOnEnqueue: false,
      separatePayloads: true,
      tenantPayloadBytesLimit: options.environmentPayloadBytesLimit,
      consumerIntervalMs: options.consumerIntervalMs,
      visibilityTimeoutMs: options.visibilityTimeoutMs ?? 60_000,
      heartbeatIntervalMs: options.visibilityTimeoutMs ?? 60_000,
      reclaimIntervalMs: options.reclaimIntervalMs,
      startConsumers: false,
      cooloff: { enabled: false },
      workerQueue: { resolveWorkerQueue: () => WORKER_QUEUE_ID },
      concurrencyGroups: [
        {
          name: "tenant",
          extractGroupId: (queue) => queue.tenantId,
          defaultLimit:
            typeof options.tenantConcurrency === "number" ? options.tenantConcurrency : 100,
          getLimit: async (environmentId) =>
            typeof options.tenantConcurrency === "number"
              ? options.tenantConcurrency
              : options.tenantConcurrency(environmentId),
        },
      ],
      workerQueueMaxDepth: options.workerQueueMaxDepth ?? Math.max(options.consumers * 4, 50),
      workerQueueDepthCheckId: WORKER_QUEUE_ID,
      retry: {
        strategy: new WebhookJobRetry(options.retryBaseDelayMs ?? 1_000),
        deadLetterQueue: false,
      },
      logger: options.logger,
      tracer: options.tracer,
      meter: options.meter,
      name: "webhook-jobs",
    });

    this.workerQueue = new WorkerQueueManager({
      redis: options.redis,
      keys: this.keys,
      logger: {
        debug: (message, context) => options.logger.debug(message, context),
        error: (message, context) => options.logger.error(message, context),
      },
    });
    this.redis = createFairQueueRedisClient(options.redis);
    const meter = options.meter ?? getMeter("webhook-engine");
    this.meter = meter;
    this.queueTime = meter.createHistogram("webhook_job_queue_time_ms", {
      description:
        "How long a webhook job's first attempt waited to start after it was due, by job. Retries aren't sampled: their stored timestamp is still the first attempt's.",
      unit: "ms",
    });
    this.runDuration = meter.createHistogram("webhook_job_run_duration_ms", {
      description: "How long one attempt of a webhook job ran, by job and outcome",
      unit: "ms",
    });
    this.exhaustedCounter = meter.createCounter("webhook_job_exhausted_total", {
      description:
        "Webhook jobs out of attempts, by job and what happened: handled, queued to retry the handler, kept for a reclaim, or given up",
    });
    this.redis.defineCommand("renewJobOwner", { numberOfKeys: 1, lua: RENEW_OWNER });
    this.redis.defineCommand("releaseJobOwner", { numberOfKeys: 1, lua: RELEASE_OWNER });
  }

  /**
   * Enqueue a job on its endpoint's queue. Enqueueing an id that is still queued or running is a
   * no-op, so a retried ingest can safely enqueue its delivery again. A deliver job throws
   * `TenantQueueFullError` when the environment is at its payload bytes limit; follow-up jobs (waiter
   * completion chunks) are never refused for it, since the work that queues them is already claimed.
   */
  async enqueue(params: {
    id: string;
    environmentId: string;
    endpointId: string;
    job: WebhookJob;
  }) {
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext);
    await this.fairQueue.enqueue({
      queueId: queueIdFor(params.environmentId, params.endpointId),
      tenantId: params.environmentId,
      messageId: messageIdFor(params.id),
      payload: Object.keys(traceContext).length > 0 ? { ...params.job, traceContext } : params.job,
      ignorePayloadBytesLimit: params.job.job !== "webhook.deliver",
    });
  }

  /** The cluster slot an environment's jobs live in. */
  slotForEnvironment(environmentId: string) {
    return clusterSlot(`webhook-jobs:${this.keys.tenantShard(environmentId)}`);
  }

  /** Whether a job id is waiting on its endpoint's queue. */
  async isQueued(params: { id: string; environmentId: string; endpointId: string }) {
    const key = this.keys.queueItemsKey(queueIdFor(params.environmentId, params.endpointId));
    return (await this.redis.hexists(key, messageIdFor(params.id))) === 1;
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (!this.gaugesRegistered) {
      this.fairQueue.registerTelemetryGauges();
      this.#registerBacklogGauges();
      this.gaugesRegistered = true;
    }
    this.fairQueue.start();
    for (let i = 0; i < this.options.consumers; i++) this.loops.push(this.#consume());
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    await this.fairQueue.stop();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  async close() {
    await this.stop();
    await this.fairQueue.close();
    await this.workerQueue.close();
    await this.redis.quit();
  }

  async #consume() {
    const idleMs = this.options.consumerIntervalMs ?? 100;
    while (this.running) {
      try {
        const popped = await this.workerQueue.pop(WORKER_QUEUE_ID);
        if (!popped) {
          await new Promise((resolve) => setTimeout(resolve, idleMs * (0.5 + Math.random())));
          continue;
        }
        const key = popped.messageKey;
        const colon = key.indexOf(":");
        if (colon === -1) continue;
        await this.#run(key.slice(0, colon), key.slice(colon + 1));
      } catch (error) {
        if (!this.running) return;
        this.options.logger.error("webhook job consumer error", {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async #run(messageId: string, queueId: string) {
    const stored = await this.fairQueue.getMessageData(messageId, queueId);
    if (!stored) {
      await this.fairQueue.completeMessage(messageId, queueId);
      return;
    }
    const attempt = stored.attempt - 1;
    const visibilityMs = this.options.visibilityTimeoutMs ?? 60_000;
    const ownerKey = `owner:${queueId}:${messageId}`;
    const ownerToken = randomUUID();
    const ownerTtlMs = this.options.ownerTtlMs ?? visibilityMs * 2;
    if ((await this.redis.set(ownerKey, ownerToken, "PX", ownerTtlMs, "NX")) !== "OK") {
      this.options.logger.warn("webhook job is still held by an earlier run; leaving it", {
        messageId,
        queueId,
      });
      return;
    }
    const heartbeat = setInterval(
      () => {
        this.fairQueue.heartbeatMessage(messageId, queueId).catch(() => {});
        this.redis.renewJobOwner(ownerKey, ownerToken, ownerTtlMs).catch(() => {});
      },
      this.options.heartbeatIntervalMs ?? visibilityMs / 3
    );
    const stillOwned = async () => {
      clearInterval(heartbeat);
      return (await this.redis.get(ownerKey)) === ownerToken;
    };
    const release = () => this.redis.releaseJobOwner(ownerKey, ownerToken).catch(() => 0);
    const job = stored.payload;
    const jobType = { job: job.job };
    const startedAt = Date.now();
    if (attempt === 0) {
      this.queueTime.record(Math.max(startedAt - stored.timestamp, 0), jobType);
    }
    const ran = (outcome: string) =>
      this.runDuration.record(Date.now() - startedAt, { ...jobType, outcome });
    const parent = job.traceContext
      ? propagation.extract(ROOT_CONTEXT, job.traceContext)
      : ROOT_CONTEXT;
    try {
      await context.with(parent, async () => {
        if (job.job === "webhook.deliver") {
          await this.options.handlers.deliver({ payload: job.payload, attempt });
        } else if (job.job === "webhook.completeWaiters") {
          await this.options.handlers.completeWaiters({ payload: job.payload, attempt });
        } else {
          await this.options.handlers.exhausted?.(job.payload.job, new Error(job.payload.error));
        }
      });
      if (!(await stillOwned())) {
        ran("abandoned");
        return this.#abandon(messageId, queueId);
      }
      ran("completed");
      await this.fairQueue.completeMessage(messageId, queueId);
      await release();
    } catch (error) {
      if (!(await stillOwned())) {
        ran("abandoned");
        return this.#abandon(messageId, queueId);
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      if (attempt >= WEBHOOK_JOB_MAX_ATTEMPTS - 1 && !isInfrastructureError(failure)) {
        ran("exhausted");
        this.options.logger.error("webhook job failed on its last attempt", {
          messageId,
          queueId,
          error: failure.message,
        });
        if (!(await this.#exhaust(job, failure, messageId, queueId))) {
          // Leave it in flight: its lease lapses and the reclaimed attempt tries the handoff again.
          await release();
          return;
        }
      } else {
        ran("retrying");
      }
      await this.fairQueue.failMessage(messageId, queueId, failure);
      await release();
    }
  }

  /**
   * A job out of attempts: run the exhausted handler, or, when it fails as well, queue it as a job of
   * its own so it still runs once whatever broke recovers. That job requeues itself the same way.
   */
  async #exhaust(
    job: QueuedWebhookJob,
    failure: Error,
    messageId: string,
    queueId: string
  ): Promise<boolean> {
    const exhausted = this.options.handlers.exhausted;
    if (!exhausted) return true;
    const original = { job: job.job === "webhook.exhausted" ? job.payload.job.job : job.job };
    if (job.job !== "webhook.exhausted") {
      try {
        await exhausted(job, failure);
        this.exhaustedCounter.add(1, { ...original, result: "handled" });
        return true;
      } catch (error) {
        this.options.logger.error("webhook job's exhausted handler failed; queueing it to retry", {
          messageId,
          queueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const record =
      job.job === "webhook.exhausted"
        ? { ...job.payload, generation: job.payload.generation + 1 }
        : {
            job,
            error: failure.message,
            origin: messageId,
            generation: 0,
            firstFailedAt: Date.now(),
          };
    if (Date.now() - record.firstFailedAt > EXHAUSTED_RECORD_MAX_AGE_MS) {
      this.options.logger.error("webhook job's exhausted handler never succeeded; giving up", {
        messageId: record.origin,
        queueId,
        error: record.error,
      });
      this.exhaustedCounter.add(1, { ...original, result: "given_up" });
      return true;
    }
    try {
      await this.fairQueue.enqueue({
        queueId,
        tenantId: tenantOf(queueId),
        messageId: `${record.origin}_exhausted_${record.generation}`,
        timestamp: Date.now() + (this.options.exhaustedRecordDelayMs ?? EXHAUSTED_RECORD_DELAY_MS),
        ignorePayloadBytesLimit: true,
        payload: {
          job: "webhook.exhausted",
          payload: record,
          ...(job.traceContext ? { traceContext: job.traceContext } : {}),
        },
      });
      this.exhaustedCounter.add(1, { ...original, result: "queued" });
      return true;
    } catch (error) {
      this.options.logger.error(
        "webhook job's exhausted record could not be queued; leaving the job",
        {
          messageId: record.origin,
          queueId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      this.exhaustedCounter.add(1, { ...original, result: "kept" });
      return false;
    }
  }

  /**
   * Each shard's backlog, read from its dispatch index: how long its oldest due job has waited, the
   * payload bytes its environments have queued or in flight, and the most any one of them holds (to
   * compare with the per-environment limit). Labelled by shard only, so there are 16 series however
   * many environments have a backlog; the environment is in the refusal logs.
   */
  #registerBacklogGauges() {
    const oldestAge = this.meter.createObservableGauge("webhook_queue_oldest_job_age_ms", {
      description: "How long the oldest due webhook job in a queue shard has waited, by shard",
      unit: "ms",
    });
    const payloadBytes = this.meter.createObservableGauge("webhook_queue_payload_bytes", {
      description: "Webhook job payload bytes queued or in flight in a queue shard, by shard",
      unit: "By",
    });
    const maxEnvironmentBytes = this.meter.createObservableGauge(
      "webhook_queue_max_environment_payload_bytes",
      {
        description:
          "The most webhook job payload bytes one environment in a queue shard has queued or in flight, by shard",
        unit: "By",
      }
    );
    this.meter.addBatchObservableCallback(
      async (observer) => {
        const now = Date.now();
        for (let shard = 0; shard < WEBHOOK_JOB_SHARDS; shard++) {
          const attributes = { shard: String(shard) };
          const environments = await this.redis.zrange(
            this.keys.dispatchKey(shard),
            0,
            999,
            "WITHSCORES"
          );
          const oldestScore = environments.length >= 2 ? Number(environments[1]) : now;
          observer.observe(oldestAge, Math.max(0, now - oldestScore), attributes);
          const bytes = await Promise.all(
            environments
              .filter((_, i) => i % 2 === 0)
              .map((environmentId) => this.fairQueue.getTenantPayloadBytes(environmentId))
          );
          observer.observe(
            payloadBytes,
            bytes.reduce((sum, value) => sum + value, 0),
            attributes
          );
          observer.observe(maxEnvironmentBytes, Math.max(0, ...bytes), attributes);
        }
      },
      [oldestAge, payloadBytes, maxEnvironmentBytes]
    );
  }

  /** A job whose lease expired was reclaimed for another attempt, which now owns its outcome. */
  #abandon(messageId: string, queueId: string) {
    this.options.logger.warn(
      "webhook job lease expired before it finished; leaving it to the retry",
      {
        messageId,
        queueId,
      }
    );
  }
}

/**
 * A running job's owner token. FairQueue settles a message by id alone, and a reclaim doesn't change
 * the attempt, so a run takes the token (SET NX) before starting and keeps it through completing or
 * failing the message. A reclaimed attempt that finds the token held leaves the job for a later
 * reclaim instead of running it, so only one run ever settles it; a run that died lets its token
 * lapse and the next reclaim takes over.
 */
const RENEW_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    renewJobOwner(key: string, token: string, ttlMs: number): Promise<number>;
    releaseJobOwner(key: string, token: string): Promise<number>;
  }
}

/** The worker queue carries `messageId:queueId`, split at the first colon, so ids can't contain one. */
function messageIdFor(id: string) {
  return id.split(":").join("_");
}

/** CRC16 (XMODEM) of a hash tag's content, mod 16384: the Redis cluster slot it maps to. */
function clusterSlot(tag: string) {
  let crc = 0;
  for (const byte of Buffer.from(tag, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16384;
}

function queueIdFor(environmentId: string, endpointId: string) {
  return `env:${environmentId}:ep:${endpointId}`;
}

function tenantOf(queueId: string) {
  const parts = queueId.split(":");
  return parts[0] === "env" && parts[1] ? parts[1] : queueId;
}
