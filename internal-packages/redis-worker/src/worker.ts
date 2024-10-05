import { Logger } from "@trigger.dev/core/logger";
import { type RedisOptions } from "ioredis";
import os from "os";
import { Worker as NodeWorker } from "worker_threads";
import { z } from "zod";
import { SimpleQueue } from "./queue.js";

type WorkerCatalog = {
  [key: string]: {
    schema: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
    visibilityTimeoutMs: number;
    retry: {
      maxAttempts: number;
      minDelayMs?: number;
      scaleFactor?: number;
    };
  };
};

type QueueCatalogFromWorkerCatalog<Catalog extends WorkerCatalog> = {
  [K in keyof Catalog]: Catalog[K]["schema"];
};

type JobHandler<Catalog extends WorkerCatalog, K extends keyof Catalog> = (params: {
  id: string;
  payload: z.infer<Catalog[K]["schema"]>;
  visibilityTimeoutMs: number;
}) => Promise<void>;

type WorkerOptions<TCatalog extends WorkerCatalog> = {
  name: string;
  redisOptions: RedisOptions;
  catalog: TCatalog;
  jobs: {
    [K in keyof TCatalog]: JobHandler<TCatalog, K>;
  };
  concurrency?: {
    workers?: number;
    tasksPerWorker?: number;
  };
  pollIntervalMs?: number;
  logger?: Logger;
};

class Worker<TCatalog extends WorkerCatalog> {
  private queue: SimpleQueue<QueueCatalogFromWorkerCatalog<TCatalog>>;
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
  }

  enqueue<K extends keyof TCatalog>({
    id,
    job,
    payload,
    visibilityTimeoutMs,
  }: {
    id?: string;
    job: K;
    payload: z.infer<TCatalog[K]["schema"]>;
    visibilityTimeoutMs?: number;
  }) {
    const timeout = visibilityTimeoutMs ?? this.options.catalog[job].visibilityTimeoutMs;
    return this.queue.enqueue({
      id,
      job,
      item: payload,
      visibilityTimeoutMs: timeout,
    });
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
        items.map(async ({ id, job, item, visibilityTimeoutMs }) => {
          const catalogItem = this.options.catalog[job as any];
          const handler = this.jobs[job as any];
          if (!handler) {
            this.logger.error(`No handler found for job type: ${job as string}`);
            return;
          }

          try {
            await handler({ id, payload: item, visibilityTimeoutMs });
            await this.queue.ack(id);
          } catch (error) {
            this.logger.error(`Error processing item, it threw an error:`, {
              name: this.options.name,
              id,
              job,
              item,
              visibilityTimeoutMs,
              error,
            });
            // Requeue the failed item with a delay
            try {
              const retryDelay = catalogItem.retry.minDelayMs ?? 1_000;
              const retryDate = new Date(Date.now() + retryDelay);
              this.logger.info(`Requeued failed item ${id} with delay`, {
                name: this.options.name,
                id,
                job,
                item,
                retryDate,
                retryDelay,
                visibilityTimeoutMs,
              });
              await this.queue.enqueue({
                id,
                job,
                item,
                availableAt: retryDate,
                visibilityTimeoutMs,
              });
            } catch (requeueError) {
              this.logger.error(`Failed to requeue item, threw error:`, {
                name: this.options.name,
                id,
                job,
                item,
                visibilityTimeoutMs,
                error: requeueError,
              });
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

  private setupShutdownHandlers() {
    process.on("SIGTERM", this.shutdown.bind(this));
    process.on("SIGINT", this.shutdown.bind(this));
  }

  private async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.log("Shutting down workers...");

    for (const worker of this.workers) {
      worker.terminate();
    }

    await this.queue.close();
    this.logger.log("All workers shut down.");
  }

  public start() {
    this.logger.log("Starting workers...");
    this.isShuttingDown = false;
    for (const worker of this.workers) {
      this.processItems(worker, this.concurrency.tasksPerWorker);
    }
  }

  public stop() {
    this.shutdown();
  }
}

export { Worker };
