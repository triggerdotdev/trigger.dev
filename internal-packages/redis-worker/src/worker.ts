import {
  MessageCatalogSchema,
  SimpleQueue,
  MessageCatalogKey,
  MessageCatalogValue,
} from "./queue.js";
import { Logger } from "@trigger.dev/core/logger";
import { Worker as NodeWorker } from "worker_threads";
import os from "os";

type JobHandler<TMessageCatalog extends MessageCatalogSchema> = (params: {
  id: string;
  payload: MessageCatalogValue<TMessageCatalog, MessageCatalogKey<TMessageCatalog>>;
  visibilityTimeoutMs: number;
}) => Promise<void>;

type WorkerOptions<TMessageCatalog extends MessageCatalogSchema> = {
  queue: SimpleQueue<TMessageCatalog>;
  jobs: {
    [K in MessageCatalogKey<TMessageCatalog>]: JobHandler<TMessageCatalog>;
  };
  concurrency?: {
    workers?: number;
    tasksPerWorker?: number;
  };
  logger?: Logger;
};

class Worker<TMessageCatalog extends MessageCatalogSchema> {
  private queue: SimpleQueue<TMessageCatalog>;
  private jobs: WorkerOptions<TMessageCatalog>["jobs"];
  private logger: Logger;
  private workers: NodeWorker[] = [];
  private isShuttingDown = false;
  private concurrency: Required<NonNullable<WorkerOptions<TMessageCatalog>["concurrency"]>>;

  constructor(options: WorkerOptions<TMessageCatalog>) {
    this.queue = options.queue;
    this.jobs = options.jobs;
    this.logger = options.logger ?? new Logger("Worker", "debug");

    const { workers = os.cpus().length, tasksPerWorker = 1 } = options.concurrency ?? {};
    this.concurrency = { workers, tasksPerWorker };

    // Initialize worker threads
    for (let i = 0; i < workers; i++) {
      this.createWorker(tasksPerWorker);
    }

    this.setupShutdownHandlers();
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

    try {
      const items = await this.queue.dequeue(count);
      if (items.length === 0) {
        setTimeout(() => this.processItems(worker, count), 1000); // Wait before trying again
        return;
      }

      worker.postMessage({ type: "process", items });

      for (const { id, job, item, visibilityTimeoutMs } of items) {
        const handler = this.jobs[job];
        if (!handler) {
          this.logger.error(`No handler found for job type: ${job as string}`);
          continue;
        }

        try {
          await handler({ id, payload: item, visibilityTimeoutMs });
          await this.queue.ack(id);
        } catch (error) {
          this.logger.error(`Error processing item ${id}:`, { error });
          // Here you might want to implement a retry mechanism or dead-letter queue
        }
      }
    } catch (error) {
      this.logger.error("Error dequeuing items:", { error });
      setTimeout(() => this.processItems(worker, count), 1000); // Wait before trying again
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
