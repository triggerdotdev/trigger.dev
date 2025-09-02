import { QueueMetricsProcessor } from "./queueMetricsProcessor.js";

export type ScalingStrategyKind = "none" | "smooth" | "aggressive";

export interface ScalingStrategyOptions {
  metricsProcessor?: QueueMetricsProcessor;
  dampingFactor?: number;
  minConsumerCount: number;
  maxConsumerCount: number;
  targetRatio: number;
}

export abstract class ScalingStrategy {
  abstract readonly name: string;

  private readonly minConsumerCount: number;
  private readonly maxConsumerCount: number;

  protected readonly targetRatio: number;

  constructor(options?: ScalingStrategyOptions) {
    this.minConsumerCount = options?.minConsumerCount ?? 1;
    this.maxConsumerCount = options?.maxConsumerCount ?? 10;
    this.targetRatio = options?.targetRatio ?? 1;
  }

  /**
   * Calculates the target consumer count with clamping to min/max bounds
   * Uses template method pattern to ensure consistent clamping across all strategies
   */
  calculateTargetCount(currentCount: number): number {
    const targetCount = this.calculateTargetCountInternal(currentCount);

    // Apply consistent clamping to all strategies
    return Math.min(Math.max(targetCount, this.minConsumerCount), this.maxConsumerCount);
  }

  /**
   * Internal method for subclasses to implement their specific scaling logic
   * Should return the unclamped target count
   */
  protected abstract calculateTargetCountInternal(currentCount: number): number;

  /**
   * Creates a scaling strategy by name
   */
  static create(strategy: ScalingStrategyKind, options?: ScalingStrategyOptions): ScalingStrategy {
    switch (strategy) {
      case "none":
        return new NoneScalingStrategy(options);

      case "smooth":
        return new SmoothScalingStrategy(options);

      case "aggressive":
        return new AggressiveScalingStrategy(options);

      default:
        throw new Error(`Unknown scaling strategy: ${strategy}`);
    }
  }
}

/**
 * Static scaling strategy - maintains a fixed number of consumers
 */
export class NoneScalingStrategy extends ScalingStrategy {
  readonly name = "none";

  constructor(options?: ScalingStrategyOptions) {
    super(options);
  }

  protected calculateTargetCountInternal(currentCount: number): number {
    return currentCount;
  }
}

/**
 * Smooth scaling strategy with EWMA smoothing and damping
 * Uses exponentially weighted moving average for queue length smoothing
 * and applies damping to prevent rapid oscillations.
 */
export class SmoothScalingStrategy extends ScalingStrategy {
  readonly name = "smooth";
  private readonly dampingFactor: number;
  private readonly metricsProcessor: QueueMetricsProcessor;

  constructor(options?: ScalingStrategyOptions) {
    super(options);
    const dampingFactor = options?.dampingFactor ?? 0.7;
    if (dampingFactor < 0 || dampingFactor > 1) {
      throw new Error("dampingFactor must be between 0 and 1");
    }
    if (!options?.metricsProcessor) {
      throw new Error("metricsProcessor is required for smooth scaling strategy");
    }
    this.dampingFactor = dampingFactor;
    this.metricsProcessor = options.metricsProcessor;
  }

  protected calculateTargetCountInternal(currentCount: number): number {
    const smoothedQueueLength = this.metricsProcessor.getSmoothedValue();

    // Calculate target consumers based on the configured ratio
    const targetConsumers = Math.ceil(smoothedQueueLength / this.targetRatio);

    // Apply damping factor to smooth out changes
    // This prevents oscillation by only moving toward the target gradually
    const dampedTarget = currentCount + (targetConsumers - currentCount) * this.dampingFactor;

    // Return rounded value without clamping (handled by base class)
    return Math.round(dampedTarget);
  }
}

/**
 * Aggressive scaling strategy with threshold-based zones
 * Uses threshold-based zones for different scaling behaviors.
 * Scales up quickly when load increases but scales down cautiously.
 */
export class AggressiveScalingStrategy extends ScalingStrategy {
  readonly name = "aggressive";
  private readonly metricsProcessor: QueueMetricsProcessor;

  constructor(options?: ScalingStrategyOptions) {
    super(options);
    if (!options?.metricsProcessor) {
      throw new Error("metricsProcessor is required for aggressive scaling strategy");
    }
    this.metricsProcessor = options.metricsProcessor;
  }

  protected calculateTargetCountInternal(currentCount: number): number {
    const smoothedQueueLength = this.metricsProcessor.getSmoothedValue();

    // Calculate queue items per consumer,
    const queuePerConsumer = smoothedQueueLength / (currentCount || 1);

    // Define zones based on targetRatio
    // Optimal zone: 0.5x to 2x the target ratio
    const scaleDownThreshold = this.targetRatio * 0.5;
    const scaleUpThreshold = this.targetRatio * 2.0;

    if (queuePerConsumer < scaleDownThreshold) {
      // Zone 1: Under-utilized (< 0.5x target ratio)
      // Scale down gradually to avoid removing too many consumers
      const reductionFactor = Math.max(0.9, 1 - (scaleDownThreshold - queuePerConsumer) * 0.1);
      // Return without min clamping (handled by base class)
      return Math.floor(currentCount * reductionFactor);
    } else if (queuePerConsumer > scaleUpThreshold) {
      // Zone 3: Over-utilized (> 2x target ratio)
      // Scale up aggressively based on queue pressure
      let scaleFactor: number;
      if (queuePerConsumer >= this.targetRatio * 5) {
        // Critical: Queue is 5x target ratio or higher
        scaleFactor = 1.5; // 50% increase
      } else if (queuePerConsumer >= this.targetRatio * 3) {
        // High: Queue is 3x target ratio
        scaleFactor = 1.3; // 30% increase
      } else {
        // Moderate: Queue is 2x target ratio
        scaleFactor = 1.1; // 10% increase
      }

      const targetCount = Math.ceil(currentCount * scaleFactor);
      // Cap increase at 50% to prevent overshooting
      const maxIncrement = Math.ceil(currentCount * 0.5);
      // Return without max clamping (handled by base class)
      return Math.min(currentCount + maxIncrement, targetCount);
    } else {
      // Zone 2: Optimal (0.5x - 2x target ratio)
      // Maintain current consumer count
      return currentCount;
    }
  }

  getThresholds(targetRatio: number) {
    return {
      scaleDownThreshold: targetRatio * 0.5,
      scaleUpThreshold: targetRatio * 2.0,
      criticalThreshold: targetRatio * 5.0,
      highThreshold: targetRatio * 3.0,
    };
  }
}
