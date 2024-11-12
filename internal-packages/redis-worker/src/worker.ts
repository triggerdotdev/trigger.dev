import { Logger } from "@trigger.dev/core/logger";
import { type RetryOptions } from "@trigger.dev/core/v3/schemas";
import { calculateNextRetryDelay } from "@trigger.dev/core/v3";
import { type RedisOptions } from "ioredis";
import os from "os";
import { Worker as NodeWorker } from "worker_threads";
import { z } from "zod";
import { SimpleQueue } from "./queue.js";

import Redis from "ioredis";

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
  logger?: Logger;
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
  private subscriber: Redis;

  queue: SimpleQueue<QueueCatalogFromWorkerCatalog<TCatalog>>;
  private jobs: WorkerOptions<TCatalog>["jobs"];
  private logger: Logger;
  private workers: NodeWorker[] = [];
  private isShuttingDown = false;
  private concurrency: Required<NonNullable<WorkerOptions<TCatalog>["concurrency"]>>;

  constructor(private options: WorkerOptions<TCatalog>) {
    this.logger = options.logger ?? new Logger("Worker", "debug");

    const schema: QueueCatalogFromWorkerCatalog<TCatalog> = Object.fromEntries(
      Object.entries(this.options.catalog).map(([key, value]) => [key, value.schema])
    ) as QueueCatalogFromWorkerCatalog<TCatalog>;
    //
    this.queue = new SimpleQueue({
      name: options.name,
      redisOptions: options.redisOptions,
      logger: this.logger,
      schema,
    });

    this.jobs = options.jobs;

    const { workers = os.cpus().length, tasksPerWorker = 1 } = options.concurrency ?? {};
    this.concurrency = { workers, tasksPerWorker };

    // Initialize worker threads
    for (let i = 0; i < workers; i++) {
      this.createWorker(tasksPerWorker);
    }

    this.setupShutdownHandlers();

    this.subscriber = new Redis(options.redisOptions);
    this.setupSubscriber();
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
    const timeout = visibilityTimeoutMs ?? this.options.catalog[job].visibilityTimeoutMs;
    return this.queue.enqueue({
      id,
      job,
      item: payload,
      visibilityTimeoutMs: timeout,
      availableAt,
    });
  }

  ack(id: string) {
    return this.queue.ack(id);
  }

  private createWorker(tasksPerWorker: number) {
    const worker = new NodeWorker(
      `
      const { parentPort } = require('worker_threads');

      parentPort.on('message', async (message) => {
        if (message.type === 'process') {
          // Process items here
          parentPort.postMessage({ type: 'done' });
        }
      });
    `,
      { eval: true }
    );

    worker.on("message", (message) => {
      if (message.type === "done") {
        this.processItems(worker, tasksPerWorker);
      }
    });

    worker.on("error", (error) => {
      this.logger.error("Worker error:", { error });
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        this.logger.warn(`Worker stopped with exit code ${code}`);
      }
      if (!this.isShuttingDown) {
        this.createWorker(tasksPerWorker);
      }
    });

    this.workers.push(worker);
    this.processItems(worker, tasksPerWorker);
  }

  private async processItems(worker: NodeWorker, count: number) {
    if (this.isShuttingDown) return;

    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;

    try {
      const items = await this.queue.dequeue(count);
      if (items.length === 0) {
        setTimeout(() => this.processItems(worker, count), pollIntervalMs);
        return;
      }

      await Promise.all(
        items.map(async ({ id, job, item, visibilityTimeoutMs, attempt }) => {
          const catalogItem = this.options.catalog[job as any];
          const handler = this.jobs[job as any];
          if (!handler) {
            this.logger.error(`No handler found for job type: ${job as string}`);
            return;
          }

          try {
            await handler({ id, payload: item, visibilityTimeoutMs, attempt });

            //succeeded, acking the item
            await this.queue.ack(id);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error processing item, it threw an error:`, {
              name: this.options.name,
              id,
              job,
              item,
              visibilityTimeoutMs,
              error,
              errorMessage,
            });
            // Requeue the failed item with a delay
            try {
              attempt = attempt + 1;

              const retrySettings = {
                ...defaultRetrySettings,
                ...catalogItem.retry,
              };

              const retryDelay = calculateNextRetryDelay(retrySettings, attempt);

              if (!retryDelay) {
                this.logger.error(
                  `Failed item ${id} has reached max attempts, moving to the DLQ.`,
                  {
                    name: this.options.name,
                    id,
                    job,
                    item,
                    visibilityTimeoutMs,
                    attempt,
                    errorMessage,
                  }
                );

                await this.queue.moveToDeadLetterQueue(id, errorMessage);
                return;
              }

              const retryDate = new Date(Date.now() + retryDelay);
              this.logger.info(`Requeued failed item ${id} with delay`, {
                name: this.options.name,
                id,
                job,
                item,
                retryDate,
                retryDelay,
                visibilityTimeoutMs,
                attempt,
              });
              await this.queue.enqueue({
                id,
                job,
                item,
                availableAt: retryDate,
                attempt,
                visibilityTimeoutMs,
              });
            } catch (requeueError) {
              this.logger.error(
                `Failed to requeue item, threw error. Will automatically get rescheduled after the visilibity timeout.`,
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
          }
        })
      );
    } catch (error) {
      this.logger.error("Error dequeuing items:", { name: this.options.name, error });
      setTimeout(() => this.processItems(worker, count), pollIntervalMs);
      return;
    }

    // Immediately process next batch because there were items in the queue
    this.processItems(worker, count);
  }

  private setupSubscriber() {
    const channel = `${this.options.name}:redrive`;
    this.subscriber.subscribe(channel, (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to ${channel}`, { error: err });
      } else {
        this.logger.log(`Subscribed to ${channel}`);
      }
    });

    this.subscriber.on("message", this.handleRedriveMessage.bind(this));
  }

  private async handleRedriveMessage(channel: string, message: string) {
    try {
      const { id } = JSON.parse(message);
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
    this.logger.log("Shutting down workers...");

    await Promise.all(this.workers.map((worker) => worker.terminate()));

    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
    await this.queue.close();
    this.logger.log("All workers and subscribers shut down.");
  }

  public start() {
    this.logger.log("Starting workers...");
    this.isShuttingDown = false;
    for (const worker of this.workers) {
      this.processItems(worker, this.concurrency.tasksPerWorker);
    }
  }

  public async stop() {
    await this.shutdown();
  }
}

export { Worker };
