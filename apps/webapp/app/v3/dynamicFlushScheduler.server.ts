import { nanoid } from "nanoid";

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
  private flushTimer: NodeJS.Timeout | null;
  private readonly callback: (flushId: string, batch: T[]) => Promise<void>;

  constructor(config: DynamicFlushSchedulerConfig<T>) {
    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.FLUSH_INTERVAL = config.flushInterval;
    this.MAX_CONCURRENCY = config.maxConcurrency || 1;
    this.callback = config.callback;
    this.flushTimer = null;
    this.startFlushTimer();
  }

  addToBatch(items: T[]): void {
    this.currentBatch.push(...items);

    if (this.currentBatch.length >= this.BATCH_SIZE) {
      this.flushNextBatch();
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

    const batch = this.currentBatch.splice(0, this.BATCH_SIZE);
    console.log("flushNextBatch", { batch });

    try {
      await this.callback(nanoid(), batch!);
      this.flushNextBatch();
    } catch (error) {
      console.error("Error inserting batch:", error);
    }
  }
}
