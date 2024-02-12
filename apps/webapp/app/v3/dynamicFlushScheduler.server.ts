export type DynamicFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  callback: (batch: T[]) => Promise<void>;
};

export class DynamicFlushScheduler<T> {
  private batchQueue: T[][]; // Adjust the type according to your data structure
  private currentBatch: T[]; // Adjust the type according to your data structure
  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL: number;
  private flushTimer: NodeJS.Timeout | null;
  private readonly callback: (batch: T[]) => Promise<void>;

  constructor(config: DynamicFlushSchedulerConfig<T>) {
    this.batchQueue = [];
    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.FLUSH_INTERVAL = config.flushInterval;
    this.callback = config.callback;
    this.flushTimer = null;
    this.startFlushTimer();
  }

  addToBatch(items: T[]): void {
    this.currentBatch.push(...items);

    if (this.currentBatch.length >= this.BATCH_SIZE) {
      this.batchQueue.push(this.currentBatch);
      this.currentBatch = [];
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
      this.batchQueue.push(this.currentBatch);
      this.currentBatch = [];
    }
    this.flushNextBatch();
  }

  private async flushNextBatch(): Promise<void> {
    if (this.batchQueue.length === 0) return;

    const batchToFlush = this.batchQueue.shift();
    try {
      await this.callback(batchToFlush!);
      if (this.batchQueue.length > 0) {
        this.flushNextBatch();
      }
    } catch (error) {
      console.error("Error inserting batch:", error);
    }
  }
}
