export interface QueueMetricsProcessorOptions {
  /**
   * EWMA smoothing factor (0-1)
   * Lower values = more smoothing, less reactive
   * Higher values = more responsive to recent changes
   */
  ewmaAlpha: number;

  /**
   * Batch window duration in milliseconds
   * Samples within this window are collected and processed together
   */
  batchWindowMs: number;
}

export interface BatchProcessingResult {
  /** Median of samples in the batch */
  median: number;

  /** EWMA-smoothed value after processing this batch */
  smoothedValue: number;

  /** Number of samples processed in this batch */
  sampleCount: number;

  /** Raw samples that were processed */
  samples: readonly number[];
}

/**
 * Processes queue length samples using exponential weighted moving average (EWMA)
 * for smoothing and median filtering for outlier resistance.
 *
 * Collects samples within a batch window, calculates median to filter outliers,
 * then applies EWMA smoothing for stable trend tracking.
 */
export class QueueMetricsProcessor {
  private readonly ewmaAlpha: number;
  private readonly batchWindowMs: number;

  private samples: number[] = [];
  private smoothedValue: number = 0;
  private lastBatchTime: number = 0;
  private isInitialized: boolean = false;

  constructor(options: QueueMetricsProcessorOptions) {
    if (options.ewmaAlpha < 0 || options.ewmaAlpha > 1) {
      throw new Error("ewmaAlpha must be between 0 and 1");
    }
    if (options.batchWindowMs <= 0) {
      throw new Error("batchWindowMs must be positive");
    }

    this.ewmaAlpha = options.ewmaAlpha;
    this.batchWindowMs = options.batchWindowMs;
  }

  /**
   * Adds a sample to the current batch
   */
  addSample(value: number, timestamp: number = Date.now()): void {
    if (value < 0) {
      throw new Error("Queue length cannot be negative");
    }

    this.samples.push(value);

    // Update last batch time on first sample
    if (this.samples.length === 1) {
      this.lastBatchTime = timestamp;
    }
  }

  /**
   * Checks if enough time has passed to process the current batch
   */
  shouldProcessBatch(currentTime: number = Date.now()): boolean {
    if (this.samples.length === 0) {
      return false;
    }

    return currentTime - this.lastBatchTime >= this.batchWindowMs;
  }

  /**
   * Processes the current batch of samples and returns the result.
   * Clears the samples array and updates the smoothed value.
   *
   * Returns null if there are no samples to process.
   */
  processBatch(currentTime: number = Date.now()): BatchProcessingResult | null {
    if (this.samples.length === 0) {
      return null;
    }

    // Calculate median of samples to filter outliers
    const sortedSamples = [...this.samples].sort((a, b) => a - b);
    const medianIndex = Math.floor(sortedSamples.length / 2);
    const median = sortedSamples[medianIndex];

    if (!median) {
      console.warn("Median should exist for n > 0 samples");
      return null;
    }

    // Update EWMA smoothed value
    if (!this.isInitialized) {
      // First value - initialize with median
      this.smoothedValue = median;
      this.isInitialized = true;
    } else {
      // Apply EWMA: s_t = α * x_t + (1 - α) * s_(t-1)
      this.smoothedValue = this.ewmaAlpha * median + (1 - this.ewmaAlpha) * this.smoothedValue;
    }

    const result: BatchProcessingResult = {
      median,
      smoothedValue: this.smoothedValue,
      sampleCount: this.samples.length,
      samples: Object.freeze([...this.samples]),
    };

    // Clear samples for next batch
    this.samples = [];
    this.lastBatchTime = currentTime;

    return result;
  }

  /**
   * Gets the current smoothed value without processing a batch
   */
  getSmoothedValue(): number {
    return this.smoothedValue;
  }

  /**
   * Gets the number of samples in the current batch
   */
  getCurrentSampleCount(): number {
    return this.samples.length;
  }

  /**
   * Gets the current samples (for testing/debugging)
   */
  getCurrentSamples(): readonly number[] {
    return Object.freeze([...this.samples]);
  }

  /**
   * Resets the processor state
   */
  reset(): void {
    this.samples = [];
    this.smoothedValue = 0;
    this.lastBatchTime = 0;
    this.isInitialized = false;
  }

  /**
   * Gets processor configuration
   */
  getConfig(): Readonly<QueueMetricsProcessorOptions> {
    return {
      ewmaAlpha: this.ewmaAlpha,
      batchWindowMs: this.batchWindowMs,
    };
  }
}
