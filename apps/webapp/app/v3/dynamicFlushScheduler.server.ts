import { Logger } from "@trigger.dev/core/logger";
import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { signalsEmitter } from "~/services/signals.server";

export type DynamicFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  callback: (flushId: string, batch: T[]) => Promise<void>;
  // New configuration options
  minConcurrency?: number;
  maxConcurrency?: number;
  maxBatchSize?: number;
  memoryPressureThreshold?: number; // Number of items that triggers increased concurrency
  loadSheddingThreshold?: number; // Number of items that triggers load shedding
  loadSheddingEnabled?: boolean;
  isDroppableEvent?: (item: T) => boolean; // Function to determine if an event can be dropped
};

export class DynamicFlushScheduler<T> {
  private batchQueue: T[][];
  private currentBatch: T[];
  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL: number;
  private flushTimer: NodeJS.Timeout | null;
  private metricsReporterTimer: NodeJS.Timeout | undefined;
  private readonly callback: (flushId: string, batch: T[]) => Promise<void>;

  // New properties for dynamic scaling
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly maxBatchSize: number;
  private readonly memoryPressureThreshold: number;
  private limiter: ReturnType<typeof pLimit>;
  private currentBatchSize: number;
  private totalQueuedItems: number = 0;
  private consecutiveFlushFailures: number = 0;
  private lastFlushTime: number = Date.now();
  private metrics = {
    flushedBatches: 0,
    failedBatches: 0,
    totalItemsFlushed: 0,
    droppedEvents: 0,
    droppedEventsByKind: new Map<string, number>(),
  };
  private isShuttingDown: boolean = false;

  // New properties for load shedding
  private readonly loadSheddingThreshold: number;
  private readonly loadSheddingEnabled: boolean;
  private readonly isDroppableEvent?: (item: T) => boolean;
  private isLoadShedding: boolean = false;

  private readonly logger: Logger = new Logger("EventRepo.DynamicFlushScheduler", "debug");

  constructor(config: DynamicFlushSchedulerConfig<T>) {
    this.batchQueue = [];
    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.currentBatchSize = config.batchSize;
    this.FLUSH_INTERVAL = config.flushInterval;
    this.callback = config.callback;
    this.flushTimer = null;

    // Initialize dynamic scaling parameters
    this.minConcurrency = config.minConcurrency ?? 1;
    this.maxConcurrency = config.maxConcurrency ?? 10;
    this.maxBatchSize = config.maxBatchSize ?? config.batchSize * 5;
    this.memoryPressureThreshold = config.memoryPressureThreshold ?? config.batchSize * 20;

    // Initialize load shedding parameters
    this.loadSheddingThreshold = config.loadSheddingThreshold ?? config.batchSize * 50;
    this.loadSheddingEnabled = config.loadSheddingEnabled ?? true;
    this.isDroppableEvent = config.isDroppableEvent;

    // Start with minimum concurrency
    this.limiter = pLimit(this.minConcurrency);

    this.startFlushTimer();
    this.startMetricsReporter();
    this.setupShutdownHandlers();
  }

  addToBatch(items: T[]): void {
    let itemsToAdd = items;

    // Apply load shedding if enabled and we're over the threshold
    if (this.loadSheddingEnabled && this.totalQueuedItems >= this.loadSheddingThreshold) {
      const { kept, dropped } = this.applyLoadShedding(items);
      itemsToAdd = kept;

      if (dropped.length > 0) {
        this.metrics.droppedEvents += dropped.length;

        // Track dropped events by kind if possible
        dropped.forEach((item) => {
          const kind = this.getEventKind(item);
          if (kind) {
            const currentCount = this.metrics.droppedEventsByKind.get(kind) || 0;
            this.metrics.droppedEventsByKind.set(kind, currentCount + 1);
          }
        });

        if (!this.isLoadShedding) {
          this.isLoadShedding = true;
        }

        this.logger.warn("Load shedding", {
          totalQueuedItems: this.totalQueuedItems,
          threshold: this.loadSheddingThreshold,
          droppedCount: dropped.length,
        });
      }
    } else if (this.isLoadShedding && this.totalQueuedItems < this.loadSheddingThreshold * 0.8) {
      this.isLoadShedding = false;
      this.logger.info("Load shedding deactivated", {
        totalQueuedItems: this.totalQueuedItems,
        threshold: this.loadSheddingThreshold,
        totalDropped: this.metrics.droppedEvents,
      });
    }

    this.currentBatch.push(...itemsToAdd);
    this.totalQueuedItems += itemsToAdd.length;

    // Check if we need to create a batch (if we are shutting down, create a batch immediately because the flush timer is stopped)
    if (this.currentBatch.length >= this.currentBatchSize || this.isShuttingDown) {
      this.createBatch();
    }

    // Adjust concurrency based on queue pressure
    this.adjustConcurrency();
  }

  private createBatch(): void {
    if (this.currentBatch.length === 0) return;

    this.batchQueue.push(this.currentBatch);
    this.currentBatch = [];
    this.flushBatches();
    this.resetFlushTimer();
  }

  private setupShutdownHandlers(): void {
    signalsEmitter.on("SIGTERM", () => this.shutdown());
    signalsEmitter.on("SIGINT", () => this.shutdown());
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.checkAndFlush(), this.FLUSH_INTERVAL);
  }

  private resetFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    if (this.isShuttingDown) return;

    this.startFlushTimer();
  }

  private checkAndFlush(): void {
    if (this.currentBatch.length > 0) {
      this.createBatch();
    }
    this.flushBatches();
  }

  private async flushBatches(): Promise<void> {
    const batchesToFlush: T[][] = [];

    // Dequeue all available batches up to current concurrency limit
    while (this.batchQueue.length > 0 && batchesToFlush.length < this.limiter.concurrency) {
      const batch = this.batchQueue.shift();
      if (batch) {
        batchesToFlush.push(batch);
      }
    }

    if (batchesToFlush.length === 0) return;

    // Schedule all batches for concurrent processing
    const flushPromises = batchesToFlush.map((batch) =>
      this.limiter(async () => {
        const flushId = nanoid();
        const itemCount = batch.length;

        try {
          const startTime = Date.now();
          await this.callback(flushId, batch);

          const duration = Date.now() - startTime;
          this.totalQueuedItems -= itemCount;
          this.consecutiveFlushFailures = 0;
          this.lastFlushTime = Date.now();
          this.metrics.flushedBatches++;
          this.metrics.totalItemsFlushed += itemCount;

          this.logger.debug("Batch flushed successfully", {
            flushId,
            itemCount,
            duration,
            remainingQueueDepth: this.totalQueuedItems,
            activeConcurrency: this.limiter.activeCount,
            pendingConcurrency: this.limiter.pendingCount,
          });
        } catch (error) {
          this.consecutiveFlushFailures++;
          this.metrics.failedBatches++;

          this.logger.error("Error flushing batch", {
            flushId,
            itemCount,
            error,
            consecutiveFailures: this.consecutiveFlushFailures,
          });

          // Re-queue the batch at the front if it fails
          this.batchQueue.unshift(batch);
          this.totalQueuedItems += itemCount;

          // Back off on failures
          if (this.consecutiveFlushFailures > 3) {
            this.adjustConcurrency(true);
          }
        }
      })
    );

    // Don't await here - let them run concurrently
    Promise.allSettled(flushPromises).then(() => {
      // After flush completes, check if we need to flush more
      if (this.batchQueue.length > 0) {
        this.flushBatches();
      }
    });
  }

  private lastConcurrencyAdjustment: number = Date.now();

  private adjustConcurrency(backOff: boolean = false): void {
    const currentConcurrency = this.limiter.concurrency;
    let newConcurrency = currentConcurrency;

    // Calculate pressure metrics - moved outside the if/else block
    const queuePressure = this.totalQueuedItems / this.memoryPressureThreshold;
    const timeSinceLastFlush = Date.now() - this.lastFlushTime;
    const timeSinceLastAdjustment = Date.now() - this.lastConcurrencyAdjustment;

    // Don't adjust too frequently (except for backoff)
    if (!backOff && timeSinceLastAdjustment < 1000) {
      return;
    }

    if (backOff) {
      // Reduce concurrency on failures
      newConcurrency = Math.max(this.minConcurrency, Math.floor(currentConcurrency * 0.75));
    } else {
      if (queuePressure > 0.8 || timeSinceLastFlush > this.FLUSH_INTERVAL * 2) {
        // High pressure - increase concurrency
        newConcurrency = Math.min(this.maxConcurrency, currentConcurrency + 2);
      } else if (queuePressure < 0.2 && currentConcurrency > this.minConcurrency) {
        // Low pressure - decrease concurrency
        newConcurrency = Math.max(this.minConcurrency, currentConcurrency - 1);
      }
    }

    // Adjust batch size based on pressure
    if (this.totalQueuedItems > this.memoryPressureThreshold) {
      this.currentBatchSize = Math.min(
        this.maxBatchSize,
        Math.floor(this.BATCH_SIZE * (1 + queuePressure))
      );
    } else {
      this.currentBatchSize = this.BATCH_SIZE;
    }

    // Update concurrency if changed
    if (newConcurrency !== currentConcurrency) {
      this.limiter = pLimit(newConcurrency);

      this.logger.info("Adjusted flush concurrency", {
        previousConcurrency: currentConcurrency,
        newConcurrency,
        queuePressure,
        totalQueuedItems: this.totalQueuedItems,
        currentBatchSize: this.currentBatchSize,
        memoryPressureThreshold: this.memoryPressureThreshold,
      });
    }
  }

  private startMetricsReporter(): void {
    // Report metrics every 30 seconds
    this.metricsReporterTimer = setInterval(() => {
      const droppedByKind: Record<string, number> = {};
      this.metrics.droppedEventsByKind.forEach((count, kind) => {
        droppedByKind[kind] = count;
      });

      this.logger.info("DynamicFlushScheduler metrics", {
        totalQueuedItems: this.totalQueuedItems,
        batchQueueLength: this.batchQueue.length,
        currentBatchLength: this.currentBatch.length,
        currentConcurrency: this.limiter.concurrency,
        activeConcurrent: this.limiter.activeCount,
        pendingConcurrent: this.limiter.pendingCount,
        currentBatchSize: this.currentBatchSize,
        isLoadShedding: this.isLoadShedding,
        metrics: {
          ...this.metrics,
          droppedByKind,
        },
      });
    }, 30000);
  }

  private applyLoadShedding(items: T[]): { kept: T[]; dropped: T[] } {
    if (!this.isDroppableEvent) {
      // If no function provided to determine droppable events, keep all
      return { kept: items, dropped: [] };
    }

    const kept: T[] = [];
    const dropped: T[] = [];

    for (const item of items) {
      if (this.isDroppableEvent(item)) {
        dropped.push(item);
      } else {
        kept.push(item);
      }
    }

    return { kept, dropped };
  }

  private getEventKind(item: T): string | undefined {
    // Try to extract the kind from the event if it has one
    if (item && typeof item === "object" && "kind" in item) {
      return String(item.kind);
    }
    return undefined;
  }

  // Method to get current status
  getStatus() {
    const droppedByKind: Record<string, number> = {};
    this.metrics.droppedEventsByKind.forEach((count, kind) => {
      droppedByKind[kind] = count;
    });

    return {
      queuedItems: this.totalQueuedItems,
      batchQueueLength: this.batchQueue.length,
      currentBatchSize: this.currentBatch.length,
      concurrency: this.limiter.concurrency,
      activeFlushes: this.limiter.activeCount,
      pendingFlushes: this.limiter.pendingCount,
      isLoadShedding: this.isLoadShedding,
      metrics: {
        ...this.metrics,
        droppedEventsByKind: droppedByKind,
      },
    };
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    if (this.metricsReporterTimer) {
      clearInterval(this.metricsReporterTimer);
    }

    // Flush any remaining items
    if (this.currentBatch.length > 0) {
      this.createBatch();
    }

    // Wait for all pending flushes to complete
    while (this.batchQueue.length > 0 || this.limiter.activeCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}