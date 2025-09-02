import { SimpleStructuredLogger } from "../../utils/structuredLogger.js";
import { QueueConsumer, RunQueueConsumer, RunQueueConsumerOptions } from "./queueConsumer.js";
import { QueueMetricsProcessor } from "./queueMetricsProcessor.js";
import {
  ScalingStrategy,
  ScalingStrategyKind,
  ScalingStrategyOptions,
} from "./scalingStrategies.js";
import { ConsumerPoolMetrics } from "./consumerPoolMetrics.js";
import type { Registry } from "prom-client";

export type QueueConsumerFactory = (opts: RunQueueConsumerOptions) => QueueConsumer;

export type ScalingOptions = {
  strategy?: ScalingStrategyKind;
  strategyOptions?: ScalingStrategyOptions;
  minConsumerCount?: number;
  maxConsumerCount?: number;
  scaleUpCooldownMs?: number;
  scaleDownCooldownMs?: number;
  targetRatio?: number;
  ewmaAlpha?: number;
  batchWindowMs?: number;
  disableJitter?: boolean;
};

export type ConsumerPoolOptions = {
  consumer: RunQueueConsumerOptions;
  scaling: ScalingOptions;
  consumerFactory?: QueueConsumerFactory;
  metricsRegistry?: Registry;
};

type ScalingMetrics = {
  targetConsumerCount: number;
  queueLength?: number;
  smoothedQueueLength: number;
  lastScaleTime: Date;
  lastQueueLengthUpdate: Date;
};

export class RunQueueConsumerPool {
  private readonly consumerOptions: RunQueueConsumerOptions;

  private readonly logger = new SimpleStructuredLogger("consumer-pool");
  private readonly promMetrics?: ConsumerPoolMetrics;

  private readonly minConsumerCount: number;
  private readonly maxConsumerCount: number;
  private readonly scalingStrategy: ScalingStrategy;
  private readonly disableJitter: boolean;

  private consumers: Map<string, QueueConsumer> = new Map();
  private readonly consumerFactory: QueueConsumerFactory;
  private isEnabled: boolean = false;
  private isScaling: boolean = false;

  private metrics: ScalingMetrics;
  private readonly metricsProcessor: QueueMetricsProcessor;

  // Scaling parameters
  private readonly ewmaAlpha: number;
  private readonly scaleUpCooldownMs: number;
  private readonly scaleDownCooldownMs: number;
  private readonly batchWindowMs: number;

  constructor(opts: ConsumerPoolOptions) {
    this.consumerOptions = opts.consumer;

    // Initialize Prometheus metrics if registry provided
    if (opts.metricsRegistry) {
      this.promMetrics = new ConsumerPoolMetrics({
        register: opts.metricsRegistry,
      });
    }

    this.minConsumerCount = Math.max(1, opts.scaling.minConsumerCount ?? 1);
    this.maxConsumerCount = Math.max(this.minConsumerCount, opts.scaling.maxConsumerCount ?? 10);
    this.scaleUpCooldownMs = opts.scaling.scaleUpCooldownMs ?? 10000; // 10 seconds default
    this.scaleDownCooldownMs = opts.scaling.scaleDownCooldownMs ?? 60000; // 60 seconds default
    this.disableJitter = opts.scaling.disableJitter ?? false;

    // Configure EWMA parameters from options
    this.ewmaAlpha = opts.scaling.ewmaAlpha ?? 0.3;
    this.batchWindowMs = opts.scaling.batchWindowMs ?? 1000;

    // Validate EWMA parameters
    if (this.ewmaAlpha < 0 || this.ewmaAlpha > 1) {
      throw new Error(`ewmaAlpha must be between 0 and 1, got: ${this.ewmaAlpha}`);
    }
    if (this.batchWindowMs <= 0) {
      throw new Error(`batchWindowMs must be positive, got: ${this.batchWindowMs}`);
    }

    // Initialize metrics processor
    this.metricsProcessor = new QueueMetricsProcessor({
      ewmaAlpha: this.ewmaAlpha,
      batchWindowMs: this.batchWindowMs,
    });

    const targetRatio = opts.scaling.targetRatio ?? 1.0;
    const dampingFactor = opts.scaling.strategyOptions?.dampingFactor;

    // Create scaling strategy with metrics processor injected
    this.scalingStrategy = ScalingStrategy.create(opts.scaling.strategy ?? "none", {
      metricsProcessor: this.metricsProcessor,
      dampingFactor,
      targetRatio,
      minConsumerCount: this.minConsumerCount,
      maxConsumerCount: this.maxConsumerCount,
    });

    // Use provided factory or default to RunQueueConsumer
    this.consumerFactory =
      opts.consumerFactory || ((consumerOpts) => new RunQueueConsumer(consumerOpts));

    this.metrics = {
      targetConsumerCount: this.minConsumerCount,
      queueLength: undefined,
      smoothedQueueLength: 0,
      lastScaleTime: new Date(0),
      lastQueueLengthUpdate: new Date(0),
    };

    this.logger.log("Initialized consumer pool", {
      minConsumerCount: this.minConsumerCount,
      maxConsumerCount: this.maxConsumerCount,
      scalingStrategy: this.scalingStrategy.name,
      mode: this.scalingStrategy.name === "none" ? "static" : "dynamic",
      ewmaAlpha: this.ewmaAlpha,
      batchWindowMs: this.batchWindowMs,
    });
  }

  async start() {
    if (this.isEnabled) {
      return;
    }

    this.isEnabled = true;

    // For 'none' strategy, start with max consumers (static mode)
    // For dynamic strategies, start with minimum
    const initialCount =
      this.scalingStrategy.name === "none" ? this.maxConsumerCount : this.minConsumerCount;

    // Set initial metrics
    this.metrics.targetConsumerCount = initialCount;

    this.addConsumers(initialCount);

    this.logger.log("Started dynamic consumer pool", {
      initialConsumerCount: this.consumers.size,
    });

    // Initialize Prometheus metrics with initial state
    this.promMetrics?.updateState({
      consumerCount: this.consumers.size,
      queueLength: this.metrics.queueLength,
      smoothedQueueLength: this.metrics.smoothedQueueLength,
      targetConsumerCount: initialCount,
      strategy: this.scalingStrategy.name,
    });
  }

  async stop() {
    if (!this.isEnabled) {
      return;
    }

    this.isEnabled = false;

    // Stop all consumers
    Array.from(this.consumers.values()).forEach((consumer) => consumer.stop());

    this.consumers.clear();

    this.logger.log("Stopped dynamic consumer pool");
  }

  /**
   * Updates the queue length metric and triggers scaling decisions
   * Uses QueueMetricsProcessor for batching and EWMA smoothing
   */
  updateQueueLength(queueLength: number) {
    // Track queue length update in metrics
    this.promMetrics?.recordQueueLengthUpdate();

    // Skip metrics tracking for static mode
    if (this.scalingStrategy.name === "none") {
      return;
    }

    // Add sample to metrics processor
    this.metricsProcessor.addSample(queueLength);

    // Check if we should process the current batch
    if (this.metricsProcessor.shouldProcessBatch()) {
      this.processMetricsBatch();
    }
  }

  private processMetricsBatch() {
    // Process batch using the metrics processor
    const result = this.metricsProcessor.processBatch();

    if (!result) {
      this.logger.debug("No queue length samples in batch window - skipping scaling evaluation");
      return;
    }

    // Update metrics
    this.metrics.queueLength = result.median;
    this.metrics.smoothedQueueLength = result.smoothedValue;
    this.metrics.lastQueueLengthUpdate = new Date();

    this.logger.verbose("Queue metrics batch processed", {
      samples: result.sampleCount,
      median: result.median,
      smoothed: result.smoothedValue,
      currentConsumerCount: this.consumers.size,
    });

    // Make scaling decision
    this.evaluateScaling();
  }

  private evaluateScaling() {
    if (!this.isEnabled) {
      return;
    }

    // No scaling in static mode
    if (this.scalingStrategy.name === "none") {
      return;
    }

    // Skip if already scaling
    if (this.isScaling) {
      this.logger.debug("Scaling blocked - operation already in progress", {
        currentCount: this.consumers.size,
        targetCount: this.metrics.targetConsumerCount,
        actualCount: this.consumers.size,
      });
      return;
    }

    const targetCount = this.calculateTargetConsumerCount();

    if (targetCount === this.consumers.size) {
      return;
    }

    const timeSinceLastScale = Date.now() - this.metrics.lastScaleTime.getTime();

    // Add random jitter to avoid thundering herd when multiple replicas exist
    // Works without needing to know replica index or count
    const jitterMs = this.disableJitter ? 0 : Math.random() * 3000; // 0-3 seconds random jitter

    // Check cooldown periods with jitter
    if (targetCount > this.consumers.size) {
      // Scale up
      const effectiveCooldown = this.scaleUpCooldownMs + jitterMs;
      if (timeSinceLastScale < effectiveCooldown) {
        this.logger.debug("Scale up blocked by cooldown", {
          timeSinceLastScale,
          cooldownMs: effectiveCooldown,
          jitterMs,
          remainingMs: effectiveCooldown - timeSinceLastScale,
        });
        this.promMetrics?.recordCooldownApplied("up");
        return;
      }
    } else if (targetCount < this.consumers.size) {
      // Scale down
      const effectiveCooldown = this.scaleDownCooldownMs + jitterMs;
      if (timeSinceLastScale < effectiveCooldown) {
        this.logger.debug("Scale down blocked by cooldown", {
          timeSinceLastScale,
          cooldownMs: effectiveCooldown,
          jitterMs,
          remainingMs: effectiveCooldown - timeSinceLastScale,
        });
        this.promMetrics?.recordCooldownApplied("down");
        return;
      }
    }

    this.logger.info("Scaling consumer pool", {
      from: this.consumers.size,
      to: targetCount,
      queueLength: this.metrics.queueLength,
      smoothedQueueLength: this.metrics.smoothedQueueLength,
      strategy: this.scalingStrategy,
    });

    // Set flag before scaling
    this.isScaling = true;

    // Update target metric for visibility
    const previousTarget = this.metrics.targetConsumerCount;
    this.metrics.targetConsumerCount = targetCount;

    try {
      this.scaleToTarget(targetCount);
    } catch (error) {
      this.logger.error("Failed to scale consumer pool", { error });
      // Revert target on failure
      this.metrics.targetConsumerCount = previousTarget;
    } finally {
      this.isScaling = false;
    }
  }

  private calculateTargetConsumerCount(): number {
    return this.scalingStrategy.calculateTargetCount(this.consumers.size);
  }

  private scaleToTarget(targetCount: number) {
    const actualCurrentCount = this.consumers.size;

    if (targetCount > actualCurrentCount) {
      // Scale up
      const count = targetCount - actualCurrentCount;
      this.addConsumers(count);
      this.promMetrics?.recordScalingOperation("up", this.scalingStrategy.name, count);
    } else if (targetCount < actualCurrentCount) {
      // Scale down
      const count = actualCurrentCount - targetCount;
      this.removeConsumers(count);
      this.promMetrics?.recordScalingOperation("down", this.scalingStrategy.name, count);
    }

    this.metrics.lastScaleTime = new Date();

    // Update Prometheus state metrics
    this.promMetrics?.updateState({
      consumerCount: this.consumers.size,
      queueLength: this.metrics.queueLength,
      smoothedQueueLength: this.metrics.smoothedQueueLength,
      targetConsumerCount: targetCount,
      strategy: this.scalingStrategy.name,
    });
  }

  private addConsumers(count: number) {
    const newConsumers: QueueConsumer[] = [];

    for (let i = 0; i < count; i++) {
      const consumerId = `consumer-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

      const consumer = this.consumerFactory({
        ...this.consumerOptions,
        onDequeue: async (messages) => {
          // Always update queue length, default to 0 for empty dequeues or missing value
          this.updateQueueLength(messages[0]?.workerQueueLength ?? 0);

          // Forward to the original handler
          await this.consumerOptions.onDequeue(messages);
        },
      });

      this.consumers.set(consumerId, consumer);
      newConsumers.push(consumer);
    }

    // Start all new consumers
    newConsumers.forEach((c) => c.start());

    this.logger.info("Added consumers", {
      count,
      totalConsumers: this.consumers.size,
    });
  }

  private removeConsumers(count: number) {
    const allIds = Array.from(this.consumers.keys());
    const consumerIds = allIds.slice(-count); // Take from the end
    const consumersToStop: QueueConsumer[] = [];

    for (const id of consumerIds) {
      const consumer = this.consumers.get(id);
      if (consumer) {
        consumersToStop.push(consumer);
        this.consumers.delete(id);
      }
    }

    // Stop removed consumers
    consumersToStop.forEach((c) => c.stop());

    this.logger.info("Removed consumers", {
      count: consumersToStop.length,
      totalConsumers: this.consumers.size,
    });
  }

  /**
   * Get current pool metrics for monitoring
   */
  getMetrics(): Readonly<ScalingMetrics> {
    return { ...this.metrics };
  }

  /**
   * Get current number of consumers in the pool
   */
  get size(): number {
    return this.consumers.size;
  }
}
