import { nanoid } from "nanoid";
import pLimit from "p-limit";

export type DynamicFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  maxConcurrency?: number;
  callback: (flushId: string, batch: T[]) => Promise<void>;
};

export class DynamicFlushScheduler<T> {
  // private batchQueue: T[][]; // Adjust the type according to your data structure
  private currentBatch: T[]; // Adjust the type according to your data structure
  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL: number;
  private readonly MAX_CONCURRENCY: number;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;
  private flushTimer: NodeJS.Timeout | null;
  private readonly callback: (flushId: string, batch: T[]) => Promise<void>;

  constructor(config: DynamicFlushSchedulerConfig<T>) {
    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.FLUSH_INTERVAL = config.flushInterval;
    this.MAX_CONCURRENCY = config.maxConcurrency || 1;
    this.concurrencyLimiter = pLimit(this.MAX_CONCURRENCY);
    this.callback = config.callback;
    this.flushTimer = null;
    this.startFlushTimer();
  }

  async addToBatch(items: T[]): Promise<void> {
    this.currentBatch.push(...items);

    if (this.currentBatch.length >= this.BATCH_SIZE) {
      await this.flushNextBatch();
      this.resetFlushTimer();
    }
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
      this.flushNextBatch();
    }
  }

  private async flushNextBatch(): Promise<void> {
    if (this.currentBatch.length === 0) return;

    const batches: T[][] = [];

    while (this.currentBatch.length > 0) {
      batches.push(this.currentBatch.splice(0, this.BATCH_SIZE));
    }

    const promises = batches.map(async (batch) =>
      this.concurrencyLimiter(async () => {
        try {
          await this.callback(nanoid(), batch!);
        } catch (error) {
          console.error("Error inserting batch:", error);
        }
      })
    );

    await Promise.all(promises);
  }
}
