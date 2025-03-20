import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { Gauge } from "prom-client";
import { metricsRegister } from "~/metrics.server";
import { logger } from "~/services/logger.server";

export type DynamicFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  maxConcurrency?: number;
  callback: (flushId: string, batch: T[]) => Promise<void>;
};

export class DynamicFlushScheduler<T> {
  private currentBatch: T[]; // Adjust the type according to your data structure
  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL: number;
  private readonly MAX_CONCURRENCY: number;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;
  private flushTimer: NodeJS.Timeout | null;
  private readonly callback: (flushId: string, batch: T[]) => Promise<void>;
  private isShuttingDown;
  private failedBatchCount;

  constructor(config: DynamicFlushSchedulerConfig<T>) {
    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.FLUSH_INTERVAL = config.flushInterval;
    this.MAX_CONCURRENCY = config.maxConcurrency || 1;
    this.concurrencyLimiter = pLimit(this.MAX_CONCURRENCY);
    this.flushTimer = null;
    this.callback = config.callback;
    this.isShuttingDown = false;
    this.failedBatchCount = 0;

    logger.info("Initializing DynamicFlushScheduler", {
      batchSize: this.BATCH_SIZE,
      flushInterval: this.FLUSH_INTERVAL,
      maxConcurrency: this.MAX_CONCURRENCY,
    });

    this.startFlushTimer();
    this.setupShutdownHandlers();

    if (!process.env.VITEST) {
      const scheduler = this;
      new Gauge({
        name: "dynamic_flush_scheduler_batch_size",
        help: "Number of items in the current dynamic flush scheduler batch",
        collect() {
          this.set(scheduler.currentBatch.length);
        },
        registers: [metricsRegister],
      });

      new Gauge({
        name: "dynamic_flush_scheduler_failed_batches",
        help: "Number of failed batches",
        collect() {
          this.set(scheduler.failedBatchCount);
        },
        registers: [metricsRegister],
      });
    }
  }

  /**
   *
   * If you want to fire and forget, don't await this method.
   */
  async addToBatch(items: T[]): Promise<void> {
    // TODO: consider using concat. spread is not performant
    this.currentBatch.push(...items);
    logger.debug("Adding items to batch", {
      currentBatchSize: this.currentBatch.length,
      itemsAdded: items.length,
    });

    if (this.currentBatch.length >= this.BATCH_SIZE) {
      logger.debug("Batch size threshold reached, initiating flush", {
        batchSize: this.BATCH_SIZE,
        currentSize: this.currentBatch.length,
      });
      await this.flushNextBatch();
      this.resetFlushTimer();
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.checkAndFlush(), this.FLUSH_INTERVAL);
    logger.debug("Started flush timer", { interval: this.FLUSH_INTERVAL });
  }

  private setupShutdownHandlers() {
    process.on("SIGTERM", this.shutdown.bind(this));
    process.on("SIGINT", this.shutdown.bind(this));
    logger.debug("Shutdown handlers configured");
  }

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logger.info("Initiating shutdown of dynamic flush scheduler", {
      remainingItems: this.currentBatch.length,
    });

    await this.checkAndFlush();
    this.clearTimer();

    logger.info("Dynamic flush scheduler shutdown complete", {
      totalFailedBatches: this.failedBatchCount,
    });
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      logger.debug("Flush timer cleared");
    }
  }

  private resetFlushTimer(): void {
    this.clearTimer();
    this.startFlushTimer();
    logger.debug("Flush timer reset");
  }

  private async checkAndFlush(): Promise<void> {
    if (this.currentBatch.length > 0) {
      logger.debug("Periodic flush check triggered", {
        currentBatchSize: this.currentBatch.length,
      });
      await this.flushNextBatch();
    }
  }

  private async flushNextBatch(): Promise<void> {
    if (this.currentBatch.length === 0) return;

    const batches: T[][] = [];
    while (this.currentBatch.length > 0) {
      batches.push(this.currentBatch.splice(0, this.BATCH_SIZE));
    }

    logger.info("Starting batch flush", {
      numberOfBatches: batches.length,
      totalItems: batches.reduce((sum, batch) => sum + batch.length, 0),
    });

    // TODO: report plimit.activeCount and pLimit.pendingCount and pLimit.concurrency to /metrics
    const promises = batches.map((batch) =>
      this.concurrencyLimiter(async () => {
        const batchId = nanoid();
        try {
          await this.callback(batchId, batch!);
        } catch (error) {
          logger.error("Error processing batch", {
            batchId,
            error,
            batchSize: batch.length,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      })
    );

    const results = await Promise.allSettled(promises);

    const failedBatches = results.filter((result) => result.status === "rejected").length;
    this.failedBatchCount += failedBatches;

    logger.info("Batch flush complete", {
      totalBatches: batches.length,
      successfulBatches: batches.length - failedBatches,
      failedBatches,
      totalFailedBatches: this.failedBatchCount,
    });
  }
}
