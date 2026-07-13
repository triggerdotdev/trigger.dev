import { Logger } from "@trigger.dev/core/logger";
import { tryCatch } from "@trigger.dev/core/utils";
import { getMeter, type Counter, type Histogram, type Meter } from "@internal/tracing";
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
  // Self-observability. `name` is the low-cardinality `scheduler` label that separates the
  // task_events / llm_metrics / otlp_metrics instances in the same process. `meter` defaults to
  // the global provider; inject one in tests. Instruments are no-op unless metrics are enabled.
  meter?: Meter;
  name?: string;
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

  private readonly logger: Logger = new Logger("EventRepo.DynamicFlushScheduler", "info");

  // Pre-allocated attribute objects (closed label sets) so the hot flush path never allocates.
  private readonly _metricAttrs: { scheduler: string };
  private readonly _batchOkAttrs: { scheduler: string; outcome: string };
  private readonly _batchFailedAttrs: { scheduler: string; outcome: string };
  private _batchesCounter?: Counter;
  private _itemsCounter?: Counter;
  private _flushDurationHistogram?: Histogram;
  private _batchSizeHistogram?: Histogram;
  private _droppedEventsCounter?: Counter;

  constructor(config: DynamicFlushSchedulerConfig<T>) {
    const schedulerName = config.name ?? "unknown";
    this._metricAttrs = { scheduler: schedulerName };
    this._batchOkAttrs = { scheduler: schedulerName, outcome: "ok" };
    this._batchFailedAttrs = { scheduler: schedulerName, outcome: "failed" };
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
    this.#setupOtelMetrics(config.meter, schedulerName);
  }

  #setupOtelMetrics(meterOverride: Meter | undefined, name: string): void {
    const meter = meterOverride ?? getMeter("ingest-flush");

    this._batchesCounter = meter.createCounter("ingest.flush.batches", {
      description: "Batches flushed to the sink, by outcome",
      unit: "batches",
    });
    this._itemsCounter = meter.createCounter("ingest.flush.items", {
      description: "Items successfully flushed to the sink",
      unit: "items",
    });
    this._flushDurationHistogram = meter.createHistogram("ingest.flush.duration", {
      description: "Wall-clock duration of a single batch flush",
      unit: "ms",
    });
    this._batchSizeHistogram = meter.createHistogram("ingest.flush.batch_size", {
      description: "Number of items in a flushed batch",
      unit: "items",
    });
    this._droppedEventsCounter = meter.createCounter("ingest.flush.dropped_events", {
      description: "Events dropped by load shedding before they reached the sink",
      unit: "events",
    });

    // Pull-based gauges: read at export time only, so they add zero hot-path cost.
    const queueDepthGauge = meter.createObservableGauge("ingest.flush.queue_depth", {
      description: "Items queued and awaiting flush",
      unit: "items",
    });
    const concurrencyGauge = meter.createObservableGauge("ingest.flush.concurrency", {
      description: "Current concurrent-flush limit",
      unit: "flushes",
    });
    const loadSheddingGauge = meter.createObservableGauge("ingest.flush.load_shedding", {
      description: "1 while actively shedding load, otherwise 0",
    });

    meter.addBatchObservableCallback(
      (result) => {
        result.observe(queueDepthGauge, this.totalQueuedItems, this._metricAttrs);
        result.observe(concurrencyGauge, this.limiter.concurrency, this._metricAttrs);
        result.observe(loadSheddingGauge, this.isLoadShedding ? 1 : 0, this._metricAttrs);
      },
      [queueDepthGauge, concurrencyGauge, loadSheddingGauge]
    );
  }

  addToBatch(items: T[]): void {
    let itemsToAdd = items;

    // Apply load shedding if enabled and we're over the threshold
    if (this.loadSheddingEnabled && this.totalQueuedItems >= this.loadSheddingThreshold) {
      const { kept, dropped } = this.applyLoadShedding(items);
      itemsToAdd = kept;

      if (dropped.length > 0) {
        this.metrics.droppedEvents += dropped.length;
        this._droppedEventsCounter?.add(dropped.length, this._metricAttrs);

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
    signalsEmitter.on("SIGTERM", () =>
      this.shutdown().catch((error) => {
        this.logger.error("Error shutting down dynamic flush scheduler", {
          error,
        });
      })
    );
    signalsEmitter.on("SIGINT", () =>
      this.shutdown().catch((error) => {
        this.logger.error("Error shutting down dynamic flush scheduler", {
          error,
        });
      })
    );
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
        const itemCount = batch.length;

        // eslint-disable-next-line no-this-alias
        const self = this;

        async function tryFlush(flushId: string, batchToFlush: T[], attempt: number = 1) {
          try {
            const startTime = Date.now();
            await self.callback(flushId, batchToFlush);

            const duration = Date.now() - startTime;
            self.totalQueuedItems -= itemCount;
            self.consecutiveFlushFailures = 0;
            self.lastFlushTime = Date.now();
            self.metrics.flushedBatches++;
            self.metrics.totalItemsFlushed += itemCount;

            self._flushDurationHistogram?.record(duration, self._metricAttrs);
            self._batchSizeHistogram?.record(itemCount, self._metricAttrs);
            self._itemsCounter?.add(itemCount, self._metricAttrs);
            self._batchesCounter?.add(1, self._batchOkAttrs);

            self.logger.debug("Batch flushed successfully", {
              flushId,
              itemCount,
              duration,
              remainingQueueDepth: self.totalQueuedItems,
              activeConcurrency: self.limiter.activeCount,
              pendingConcurrency: self.limiter.pendingCount,
            });
          } catch (error) {
            self.consecutiveFlushFailures++;
            self.metrics.failedBatches++;

            self.logger.error("Error attempting to flush batch", {
              flushId,
              itemCount,
              error,
              consecutiveFailures: self.consecutiveFlushFailures,
              attempt,
            });

            // Back off on failures
            if (self.consecutiveFlushFailures > 5) {
              self.adjustConcurrency(true);
            }

            if (attempt <= 3) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              return await tryFlush(flushId, batchToFlush, attempt + 1);
            } else {
              throw error;
            }
          }
        }

        const [flushError] = await tryCatch(tryFlush(nanoid(), batch));

        if (flushError) {
          this.logger.error("Error flushing batch", {
            error: flushError,
          });
          this._batchesCounter?.add(1, this._batchFailedAttrs);
        }
      })
    );

    // Don't await here - let them run concurrently
    Promise.allSettled(flushPromises).then(() => {
      const shouldContinueFlushing =
        this.batchQueue.length > 0 && (this.consecutiveFlushFailures < 3 || this.isShuttingDown);
      // After flush completes, check if we need to flush more
      if (shouldContinueFlushing) {
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

      this.logger.debug("Adjusted flush concurrency", {
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

      this.logger.debug("DynamicFlushScheduler metrics", {
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
