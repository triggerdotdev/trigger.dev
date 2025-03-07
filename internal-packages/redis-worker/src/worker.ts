import { SpanKind, startSpan, trace, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { calculateNextRetryDelay } from "@trigger.dev/core/v3";
import { type RetryOptions } from "@trigger.dev/core/v3/schemas";
import { Redis, type RedisOptions } from "@internal/redis";
import { z } from "zod";
import { AnyQueueItem, SimpleQueue } from "./queue.js";
import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { createRedisClient } from "@internal/redis";

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

type JobHandler<Catalog extends WorkerCatalog, K extends keyof Catalog> = (params: {
  id: string;
  payload: z.infer<Catalog[K]["schema"]>;
  visibilityTimeoutMs: number;
  attempt: number;
}) => Promise<void>;

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
  logger?: Logger;
  tracer?: Tracer;
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

  queue: SimpleQueue<QueueCatalogFromWorkerCatalog<TCatalog>>;
  private jobs: WorkerOptions<TCatalog>["jobs"];
  private logger: Logger;
  private workerLoops: Promise<void>[] = [];
  private isShuttingDown = false;
  private concurrency: Required<NonNullable<WorkerOptions<TCatalog>["concurrency"]>>;

  // The p-limit limiter to control overall concurrency.
  private limiter: ReturnType<typeof pLimit>;

  constructor(private options: WorkerOptions<TCatalog>) {
    this.logger = options.logger ?? new Logger("Worker", "debug");
    this.tracer = options.tracer ?? trace.getTracer(options.name);

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
  }

  public start() {
    const { workers, tasksPerWorker } = this.concurrency;

    // Launch a number of "worker loops" on the main thread.
    for (let i = 0; i < workers; i++) {
      this.workerLoops.push(this.runWorkerLoop(`worker-${nanoid(12)}`, tasksPerWorker));
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
        const timeout = visibilityTimeoutMs ?? this.options.catalog[job].visibilityTimeoutMs;

        span.setAttribute("job_visibility_timeout_ms", timeout);

        return this.queue.enqueue({
          id,
          job,
          item: payload,
          visibilityTimeoutMs: timeout,
          availableAt,
        });
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          job_type: job as string,
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
        return this.queue.reschedule(id, availableAt);
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
        return this.queue.ack(id);
      },
      {
        attributes: {
          job_id: id,
        },
      }
    );
  }

  /**
   * The main loop that each worker runs. It repeatedly polls for items,
   * processes them, and then waits before the next iteration.
   */
  private async runWorkerLoop(workerId: string, taskCount: number): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    const immediatePollIntervalMs = this.options.immediatePollIntervalMs ?? 100;

    while (!this.isShuttingDown) {
      // Check overall load. If at capacity, wait a bit before trying to dequeue more.
      if (this.limiter.activeCount + this.limiter.pendingCount >= this.concurrency.limit) {
        await Worker.delay(pollIntervalMs);
        continue;
      }

      try {
        const items = await this.queue.dequeue(taskCount);

        if (items.length === 0) {
          await Worker.delay(pollIntervalMs);
          continue;
        }

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
  }

  /**
   * Processes a single item.
   */
  private async processItem(
    { id, job, item, visibilityTimeoutMs, attempt, timestamp }: AnyQueueItem,
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
        await handler({ id, payload: item, visibilityTimeoutMs, attempt });
        // On success, acknowledge the item.
        await this.queue.ack(id);
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
          ...catalogItem.retry,
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
        this.logger.log(`Subscribed to ${channel}`);
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
      await this.queue.redriveFromDeadLetterQueue(id);
      this.logger.log(`Redrived item ${id} from Dead Letter Queue`);
    } catch (error) {
      this.logger.error("Error processing redrive message", { error, message });
    }
  }

  private setupShutdownHandlers() {
    process.on("SIGTERM", this.shutdown.bind(this));
    process.on("SIGINT", this.shutdown.bind(this));
  }

  private async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.log("Shutting down worker loops...");

    // Wait for all worker loops to finish.
    await Promise.all(this.workerLoops);

    await this.subscriber?.unsubscribe();
    await this.subscriber?.quit();
    await this.queue.close();
    this.logger.log("All workers and subscribers shut down.");
  }

  public async stop() {
    await this.shutdown();
  }
}

export { Worker };
