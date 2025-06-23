import { createRedisClient, Redis, type RedisOptions } from "@internal/redis";
import {
  Attributes,
  Histogram,
  Meter,
  metrics,
  ObservableResult,
  SpanKind,
  startSpan,
  trace,
  Tracer,
  ValueType,
} from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { calculateNextRetryDelay } from "@trigger.dev/core/v3";
import { type RetryOptions } from "@trigger.dev/core/v3/schemas";
import { shutdownManager } from "@trigger.dev/core/v3/serverOnly";
import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { z } from "zod";
import { AnyQueueItem, SimpleQueue } from "./queue.js";

export type WorkerCatalog = {
  [key: string]: {
    schema: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
    visibilityTimeoutMs: number;
    retry?: RetryOptions;
  };
};

type QueueCatalogFromWorkerCatalog<Catalog extends WorkerCatalog> = {
  [K in keyof Catalog]: Catalog[K]["schema"];
};

export type JobHandlerParams<Catalog extends WorkerCatalog, K extends keyof Catalog> = {
  id: string;
  payload: z.infer<Catalog[K]["schema"]>;
  visibilityTimeoutMs: number;
  attempt: number;
  deduplicationKey?: string;
};

export type JobHandler<Catalog extends WorkerCatalog, K extends keyof Catalog> = (
  params: JobHandlerParams<Catalog, K>
) => Promise<void>;

export type WorkerConcurrencyOptions = {
  workers?: number;
  tasksPerWorker?: number;
  limit?: number;
};

type WorkerOptions<TCatalog extends WorkerCatalog> = {
  name: string;
  redisOptions: RedisOptions;
  catalog: TCatalog;
  jobs: {
    [K in keyof TCatalog]: JobHandler<TCatalog, K>;
  };
  concurrency?: WorkerConcurrencyOptions;
  pollIntervalMs?: number;
  immediatePollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  logger?: Logger;
  tracer?: Tracer;
  meter?: Meter;
};

// This results in attempt 12 being a delay of 1 hour
const defaultRetrySettings = {
  maxAttempts: 12,
  factor: 2,
  //one second
  minTimeoutInMs: 1_000,
  //one hour
  maxTimeoutInMs: 3_600_000,
  randomize: true,
};

class Worker<TCatalog extends WorkerCatalog> {
  private subscriber: Redis | undefined;
  private tracer: Tracer;
  private meter: Meter;

  private metrics: {
    enqueueDuration?: Histogram;
    dequeueDuration?: Histogram;
    jobDuration?: Histogram;
    ackDuration?: Histogram;
    redriveDuration?: Histogram;
    rescheduleDuration?: Histogram;
  } = {};

  queue: SimpleQueue<QueueCatalogFromWorkerCatalog<TCatalog>>;
  private jobs: WorkerOptions<TCatalog>["jobs"];
  private logger: Logger;
  private workerLoops: Promise<void>[] = [];
  private isShuttingDown = false;
  private concurrency: Required<NonNullable<WorkerOptions<TCatalog>["concurrency"]>>;
  private shutdownTimeoutMs: number;

  // The p-limit limiter to control overall concurrency.
  private limiter: ReturnType<typeof pLimit>;

  constructor(private options: WorkerOptions<TCatalog>) {
    this.logger = options.logger ?? new Logger("Worker", "debug");
    this.tracer = options.tracer ?? trace.getTracer(options.name);
    this.meter = options.meter ?? metrics.getMeter(options.name);

    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 60_000;

    const schema: QueueCatalogFromWorkerCatalog<TCatalog> = Object.fromEntries(
      Object.entries(this.options.catalog).map(([key, value]) => [key, value.schema])
    ) as QueueCatalogFromWorkerCatalog<TCatalog>;

    this.queue = new SimpleQueue({
      name: options.name,
      redisOptions: options.redisOptions,
      logger: this.logger,
      schema,
    });

    this.jobs = options.jobs;

    const { workers = 1, tasksPerWorker = 1, limit = 10 } = options.concurrency ?? {};
    this.concurrency = { workers, tasksPerWorker, limit };

    // Create a p-limit instance using this limit.
    this.limiter = pLimit(this.concurrency.limit);

    const masterQueueObservableGauge = this.meter.createObservableGauge("redis_worker.queue.size", {
      description: "The number of items in the queue",
      unit: "items",
      valueType: ValueType.INT,
    });

    masterQueueObservableGauge.addCallback(this.#updateQueueSizeMetric.bind(this));

    const deadLetterQueueObservableGauge = this.meter.createObservableGauge(
      "redis_worker.queue.dead_letter_size",
      {
        description: "The number of items in the dead letter queue",
        unit: "items",
        valueType: ValueType.INT,
      }
    );

    deadLetterQueueObservableGauge.addCallback(this.#updateDeadLetterQueueSizeMetric.bind(this));

    const concurrencyLimitActiveObservableGauge = this.meter.createObservableGauge(
      "redis_worker.concurrency.active",
      {
        description: "The number of active workers",
        unit: "workers",
        valueType: ValueType.INT,
      }
    );

    concurrencyLimitActiveObservableGauge.addCallback(
      this.#updateConcurrencyLimitActiveMetric.bind(this)
    );

    const concurrencyLimitPendingObservableGauge = this.meter.createObservableGauge(
      "redis_worker.concurrency.pending",
      {
        description: "The number of pending workers",
        unit: "workers",
        valueType: ValueType.INT,
      }
    );

    concurrencyLimitPendingObservableGauge.addCallback(
      this.#updateConcurrencyLimitPendingMetric.bind(this)
    );
  }

  async #updateQueueSizeMetric(observableResult: ObservableResult<Attributes>) {
    const queueSize = await this.queue.size();

    observableResult.observe(queueSize, {
      worker_name: this.options.name,
    });
  }

  async #updateDeadLetterQueueSizeMetric(observableResult: ObservableResult<Attributes>) {
    const deadLetterQueueSize = await this.queue.sizeOfDeadLetterQueue();
    observableResult.observe(deadLetterQueueSize, {
      worker_name: this.options.name,
    });
  }

  async #updateConcurrencyLimitActiveMetric(observableResult: ObservableResult<Attributes>) {
    observableResult.observe(this.limiter.activeCount, {
      worker_name: this.options.name,
    });
  }

  async #updateConcurrencyLimitPendingMetric(observableResult: ObservableResult<Attributes>) {
    observableResult.observe(this.limiter.pendingCount, {
      worker_name: this.options.name,
    });
  }

  public start() {
    const { workers, tasksPerWorker } = this.concurrency;

    // Launch a number of "worker loops" on the main thread.
    for (let i = 0; i < workers; i++) {
      this.workerLoops.push(this.runWorkerLoop(`worker-${nanoid(12)}`, tasksPerWorker, i, workers));
    }

    this.setupShutdownHandlers();

    this.subscriber = createRedisClient(this.options.redisOptions, {
      onError: (error) => {
        this.logger.error(`RedisWorker subscriber redis client error:`, {
          error,
          keyPrefix: this.options.redisOptions.keyPrefix,
        });
      },
    });
    this.setupSubscriber();

    return this;
  }

  /**
   * Enqueues a job for processing.
   * @param options - The enqueue options.
   * @param options.id - Optional unique identifier for the job. If not provided, one will be generated. It prevents duplication.
   * @param options.job - The job type from the worker catalog.
   * @param options.payload - The job payload that matches the schema defined in the catalog.
   * @param options.visibilityTimeoutMs - Optional visibility timeout in milliseconds. Defaults to value from catalog.
   * @param options.availableAt - Optional date when the job should become available for processing. Defaults to now.
   * @returns A promise that resolves when the job is enqueued.
   */
  enqueue<K extends keyof TCatalog>({
    id,
    job,
    payload,
    visibilityTimeoutMs,
    availableAt,
  }: {
    id?: string;
    job: K;
    payload: z.infer<TCatalog[K]["schema"]>;
    visibilityTimeoutMs?: number;
    availableAt?: Date;
  }) {
    return startSpan(
      this.tracer,
      "enqueue",
      async (span) => {
        const timeout = visibilityTimeoutMs ?? this.options.catalog[job]?.visibilityTimeoutMs;

        if (!timeout) {
          throw new Error(`No visibility timeout found for job ${String(job)} with id ${id}`);
        }

        span.setAttribute("job_visibility_timeout_ms", timeout);

        return this.withHistogram(
          this.metrics.enqueueDuration,
          this.queue.enqueue({
            id,
            job,
            item: payload,
            visibilityTimeoutMs: timeout,
            availableAt,
          }),
          {
            job_type: String(job),
            has_available_at: availableAt ? "true" : "false",
          }
        );
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          job_type: String(job),
          job_id: id,
        },
      }
    );
  }

  /**
   * Enqueues a job for processing once. If the job is already in the queue, it will be ignored.
   * @param options - The enqueue options.
   * @param options.id - Required unique identifier for the job.
   * @param options.job - The job type from the worker catalog.
   * @param options.payload - The job payload that matches the schema defined in the catalog.
   * @param options.visibilityTimeoutMs - Optional visibility timeout in milliseconds. Defaults to value from catalog.
   * @param options.availableAt - Optional date when the job should become available for processing. Defaults to now.
   * @returns A promise that resolves when the job is enqueued.
   */
  enqueueOnce<K extends keyof TCatalog>({
    id,
    job,
    payload,
    visibilityTimeoutMs,
    availableAt,
  }: {
    id: string;
    job: K;
    payload: z.infer<TCatalog[K]["schema"]>;
    visibilityTimeoutMs?: number;
    availableAt?: Date;
  }) {
    return startSpan(
      this.tracer,
      "enqueueOnce",
      async (span) => {
        const timeout = visibilityTimeoutMs ?? this.options.catalog[job]?.visibilityTimeoutMs;

        if (!timeout) {
          throw new Error(`No visibility timeout found for job ${String(job)} with id ${id}`);
        }

        span.setAttribute("job_visibility_timeout_ms", timeout);

        return this.withHistogram(
          this.metrics.enqueueDuration,
          this.queue.enqueueOnce({
            id,
            job,
            item: payload,
            visibilityTimeoutMs: timeout,
            availableAt,
          }),
          {
            job_type: String(job),
            has_available_at: availableAt ? "true" : "false",
          }
        );
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          job_type: String(job),
          job_id: id,
        },
      }
    );
  }

  /**
   * Reschedules an existing job to a new available date.
   * If the job isn't in the queue, it will be ignored.
   */
  reschedule(id: string, availableAt: Date) {
    return startSpan(
      this.tracer,
      "reschedule",
      async (span) => {
        return this.withHistogram(
          this.metrics.rescheduleDuration,
          this.queue.reschedule(id, availableAt)
        );
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          job_id: id,
        },
      }
    );
  }

  ack(id: string) {
    return startSpan(
      this.tracer,
      "ack",
      () => {
        return this.withHistogram(this.metrics.ackDuration, this.queue.ack(id));
      },
      {
        attributes: {
          job_id: id,
        },
      }
    );
  }

  async getJob(id: string) {
    return this.queue.getJob(id);
  }

  /**
   * The main loop that each worker runs. It repeatedly polls for items,
   * processes them, and then waits before the next iteration.
   */
  private async runWorkerLoop(
    workerId: string,
    taskCount: number,
    workerIndex: number,
    totalWorkers: number
  ): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    const immediatePollIntervalMs = this.options.immediatePollIntervalMs ?? 100;

    // Calculate the delay between starting each worker loop so that they don't all start at the same time.
    const delayBetweenWorkers = this.options.pollIntervalMs ?? 1000;
    const delay = delayBetweenWorkers * (totalWorkers - workerIndex);
    await Worker.delay(delay);

    this.logger.info("Starting worker loop", {
      workerIndex,
      totalWorkers,
      delay,
      workerId,
      taskCount,
      pollIntervalMs,
      immediatePollIntervalMs,
      concurrencyOptions: this.concurrency,
    });

    while (!this.isShuttingDown) {
      // Check overall load. If at capacity, wait a bit before trying to dequeue more.
      if (this.limiter.activeCount + this.limiter.pendingCount >= this.concurrency.limit) {
        this.logger.debug("Worker at capacity, waiting", {
          workerId,
          concurrencyOptions: this.concurrency,
          activeCount: this.limiter.activeCount,
          pendingCount: this.limiter.pendingCount,
        });

        await Worker.delay(pollIntervalMs);

        continue;
      }

      try {
        const items = await this.withHistogram(
          this.metrics.dequeueDuration,
          this.queue.dequeue(taskCount),
          {
            worker_id: workerId,
            task_count: taskCount,
          }
        );

        if (items.length === 0) {
          this.logger.debug("No items to dequeue", {
            workerId,
            concurrencyOptions: this.concurrency,
            activeCount: this.limiter.activeCount,
            pendingCount: this.limiter.pendingCount,
          });

          await Worker.delay(pollIntervalMs);
          continue;
        }

        this.logger.debug("Dequeued items", {
          workerId,
          itemCount: items.length,
          concurrencyOptions: this.concurrency,
          activeCount: this.limiter.activeCount,
          pendingCount: this.limiter.pendingCount,
        });

        // Schedule each item using the limiter.
        for (const item of items) {
          this.limiter(() => this.processItem(item as AnyQueueItem, items.length, workerId)).catch(
            (err) => {
              this.logger.error("Unhandled error in processItem:", { error: err, workerId, item });
            }
          );
        }
      } catch (error) {
        this.logger.error("Error dequeuing items:", { name: this.options.name, error });
        await Worker.delay(pollIntervalMs);
        continue;
      }

      // Wait briefly before immediately polling again since we processed items
      await Worker.delay(immediatePollIntervalMs);
    }

    this.logger.info("Worker loop finished", { workerId });
  }

  /**
   * Processes a single item.
   */
  private async processItem(
    { id, job, item, visibilityTimeoutMs, attempt, timestamp, deduplicationKey }: AnyQueueItem,
    batchSize: number,
    workerId: string
  ): Promise<void> {
    const catalogItem = this.options.catalog[job as any];
    const handler = this.jobs[job as any];
    if (!handler) {
      this.logger.error(`No handler found for job type: ${job}`);
      return;
    }

    await startSpan(
      this.tracer,
      "processItem",
      async () => {
        await this.withHistogram(
          this.metrics.jobDuration,
          handler({ id, payload: item, visibilityTimeoutMs, attempt, deduplicationKey }),
          {
            worker_id: workerId,
            batch_size: batchSize,
            job_type: job,
            attempt,
          }
        );

        // On success, acknowledge the item.
        await this.queue.ack(id, deduplicationKey);
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          job_id: id,
          job_type: job,
          attempt,
          job_timestamp: timestamp.getTime(),
          job_age_in_ms: Date.now() - timestamp.getTime(),
          worker_id: workerId,
          worker_limit_concurrency: this.limiter.concurrency,
          worker_limit_active: this.limiter.activeCount,
          worker_limit_pending: this.limiter.pendingCount,
          worker_name: this.options.name,
          batch_size: batchSize,
        },
      }
    ).catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing item:`, {
        name: this.options.name,
        id,
        job,
        item,
        visibilityTimeoutMs,
        error,
        errorMessage,
      });
      // Attempt requeue logic.
      try {
        const newAttempt = attempt + 1;
        const retrySettings = {
          ...defaultRetrySettings,
          ...catalogItem?.retry,
        };
        const retryDelay = calculateNextRetryDelay(retrySettings, newAttempt);

        if (!retryDelay) {
          this.logger.error(`Item ${id} reached max attempts. Moving to DLQ.`, {
            name: this.options.name,
            id,
            job,
            item,
            visibilityTimeoutMs,
            attempt: newAttempt,
            errorMessage,
          });
          await this.queue.moveToDeadLetterQueue(id, errorMessage);
          return;
        }

        const retryDate = new Date(Date.now() + retryDelay);
        this.logger.info(`Requeuing failed item ${id} with delay`, {
          name: this.options.name,
          id,
          job,
          item,
          retryDate,
          retryDelay,
          visibilityTimeoutMs,
          attempt: newAttempt,
        });
        await this.queue.enqueue({
          id,
          job,
          item,
          availableAt: retryDate,
          attempt: newAttempt,
          visibilityTimeoutMs,
        });
      } catch (requeueError) {
        this.logger.error(
          `Failed to requeue item ${id}. It will be retried after the visibility timeout.`,
          {
            name: this.options.name,
            id,
            job,
            item,
            visibilityTimeoutMs,
            error: requeueError,
          }
        );
      }
    });
  }

  private async withHistogram<T>(
    histogram: Histogram | undefined,
    promise: Promise<T>,
    labels?: Record<string, string | number>
  ): Promise<T> {
    if (!histogram) {
      return promise;
    }

    const start = Date.now();
    try {
      return await promise;
    } finally {
      const duration = (Date.now() - start) / 1000; // Convert to seconds
      histogram.record(duration, { worker_name: this.options.name, ...labels });
    }
  }

  // A simple helper to delay for a given number of milliseconds.
  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private setupSubscriber() {
    const channel = `${this.options.name}:redrive`;
    this.subscriber?.subscribe(channel, (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to ${channel}`, { error: err });
      } else {
        this.logger.debug(`Subscribed to ${channel}`);
      }
    });

    this.subscriber?.on("message", this.handleRedriveMessage.bind(this));
  }

  private async handleRedriveMessage(channel: string, message: string) {
    try {
      const { id } = JSON.parse(message) as any;
      if (typeof id !== "string") {
        throw new Error("Invalid message format: id must be a string");
      }
      await this.withHistogram(
        this.metrics.redriveDuration,
        this.queue.redriveFromDeadLetterQueue(id)
      );
      this.logger.log(`Redrived item ${id} from Dead Letter Queue`);
    } catch (error) {
      this.logger.error("Error processing redrive message", { error, message });
    }
  }

  private setupShutdownHandlers() {
    shutdownManager.register(`redis-worker:${this.options.name}`, this.shutdown.bind(this));
  }

  private async shutdown(signal?: NodeJS.Signals) {
    if (this.isShuttingDown) {
      this.logger.log("Worker already shutting down", { signal });
      return;
    }

    this.isShuttingDown = true;
    this.logger.log("Shutting down worker loops...", { signal });

    // Wait for all worker loops to finish.
    await Promise.race([
      Promise.all(this.workerLoops),
      Worker.delay(this.shutdownTimeoutMs).then(() => {
        this.logger.error("Worker shutdown timed out", {
          signal,
          shutdownTimeoutMs: this.shutdownTimeoutMs,
        });
      }),
    ]);

    await this.subscriber?.unsubscribe();
    await this.subscriber?.quit();
    await this.queue.close();
    this.logger.log("All workers and subscribers shut down.", { signal });
  }

  public async stop() {
    shutdownManager.unregister(`redis-worker:${this.options.name}`);
    await this.shutdown();
  }
}

export { Worker };
