import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { logger } from "~/services/logger.server";

export type DynamicFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  callback: (flushId: string, batch: T[]) => Promise<void>;
  // New configuration options
  minConcurrency?: number;
  maxConcurrency?: number;
  maxBatchSize?: number;
  memoryPressureThreshold?: number; // Number of items that triggers increased concurrency
};

export class DynamicFlushScheduler<T> {
  private batchQueue: T[][]; 
  private currentBatch: T[]; 
  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL: number;
  private flushTimer: NodeJS.Timeout | null;
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
  };

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
    
    // Start with minimum concurrency
    this.limiter = pLimit(this.minConcurrency);
    
    this.startFlushTimer();
    this.startMetricsReporter();
  }

  addToBatch(items: T[]): void {
    this.currentBatch.push(...items);
    this.totalQueuedItems += items.length;

    // Check if we need to create a batch
    if (this.currentBatch.length >= this.currentBatchSize) {
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

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.checkAndFlush(), this.FLUSH_INTERVAL);
  }

  private resetFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
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
          
          logger.debug("Batch flushed successfully", {
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
          
          logger.error("Error flushing batch", {
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

  private adjustConcurrency(backOff: boolean = false): void {
    const currentConcurrency = this.limiter.concurrency;
    let newConcurrency = currentConcurrency;
    
    if (backOff) {
      // Reduce concurrency on failures
      newConcurrency = Math.max(this.minConcurrency, Math.floor(currentConcurrency * 0.75));
    } else {
      // Calculate pressure metrics
      const queuePressure = this.totalQueuedItems / this.memoryPressureThreshold;
      const timeSinceLastFlush = Date.now() - this.lastFlushTime;
      
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
      
      logger.info("Adjusted flush concurrency", {
        previousConcurrency: currentConcurrency,
        newConcurrency,
        queuePressure,
        totalQueuedItems: this.totalQueuedItems,
        currentBatchSize: this.currentBatchSize,
      });
    }
  }
  
  private startMetricsReporter(): void {
    // Report metrics every 30 seconds
    setInterval(() => {
      logger.info("DynamicFlushScheduler metrics", {
        totalQueuedItems: this.totalQueuedItems,
        batchQueueLength: this.batchQueue.length,
        currentBatchLength: this.currentBatch.length,
        currentConcurrency: this.limiter.concurrency,
        activeConcurrent: this.limiter.activeCount,
        pendingConcurrent: this.limiter.pendingCount,
        currentBatchSize: this.currentBatchSize,
        metrics: this.metrics,
      });
    }, 30000);
  }

  // Method to get current status
  getStatus() {
    return {
      queuedItems: this.totalQueuedItems,
      batchQueueLength: this.batchQueue.length,
      currentBatchSize: this.currentBatch.length,
      concurrency: this.limiter.concurrency,
      activeFlushes: this.limiter.activeCount,
      pendingFlushes: this.limiter.pendingCount,
      metrics: { ...this.metrics },
    };
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
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