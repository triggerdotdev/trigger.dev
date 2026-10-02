import { randomUUID } from "node:crypto";
import type { Logger } from "@trigger.dev/core/logger";
import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import {
  CallbackFairQueueKeyProducer,
  DRRScheduler,
  ExponentialBackoffRetry,
  FairQueue,
  WorkerQueueManager,
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

export const DeliverJobPayload = z.object({
  deliveryId: z.string(),
  createdAt: z.coerce.date(),
  arrivedAt: z.number().optional(),
  liveWaiters: z.boolean().optional(),
  waiterId: z.string().optional(),
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

/** A job handler. `attempt` counts from 0; a throw retries with backoff until the last attempt. */
type JobHandler<T> = (params: { payload: T; attempt: number }) => Promise<void>;

export type WebhookJobQueueOptions = {
  redis: RedisOptions;
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
  private readonly keys: CallbackFairQueueKeyProducer;
  private readonly redis: Redis;
  private readonly queueTime: Histogram;
  private readonly runDuration: Histogram;
  private readonly exhaustedCounter: Counter;
  private loops: Promise<void>[] = [];
  private running = false;
  private gaugesRegistered = false;

  constructor(private readonly options: WebhookJobQueueOptions) {
    this.keys = new CallbackFairQueueKeyProducer({
      prefix: "webhook-jobs",
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
        strategy: new ExponentialBackoffRetry({
          maxAttempts: WEBHOOK_JOB_MAX_ATTEMPTS,
          minTimeoutInMs: 1_000,
          maxTimeoutInMs: 30_000,
          factor: 2,
          randomize: true,
        }),
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
    this.redis = createRedisClient(options.redis);
    const meter = options.meter ?? getMeter("webhook-engine");
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
   * Enqueue a job on its endpoint's queue. Re-enqueueing an id that is still queued replaces it
   * rather than adding a second copy.
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
    });
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
      if (attempt >= WEBHOOK_JOB_MAX_ATTEMPTS - 1) {
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

function queueIdFor(environmentId: string, endpointId: string) {
  return `env:${environmentId}:ep:${endpointId}`;
}

function tenantOf(queueId: string) {
  const parts = queueId.split(":");
  return parts[0] === "env" && parts[1] ? parts[1] : queueId;
}
