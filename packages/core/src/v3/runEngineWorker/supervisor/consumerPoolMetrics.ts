import { Counter, Gauge, Histogram, Registry } from "prom-client";

export interface ConsumerPoolMetricsOptions {
  register?: Registry;
  prefix?: string;
}

export class ConsumerPoolMetrics {
  private readonly register: Registry;
  private readonly prefix: string;

  // Current state metrics
  public readonly consumerCount: Gauge;
  public readonly queueLength: Gauge;
  public readonly smoothedQueueLength: Gauge;
  public readonly targetConsumerCount: Gauge;
  public readonly scalingStrategy: Gauge;

  // Scaling operation metrics
  public readonly scalingOperationsTotal: Counter;
  public readonly consumersAddedTotal: Counter;
  public readonly consumersRemovedTotal: Counter;
  public readonly scalingCooldownsApplied: Counter;

  // Performance metrics
  public readonly queueLengthUpdatesTotal: Counter;
  public readonly batchesProcessedTotal: Counter;

  constructor(opts: ConsumerPoolMetricsOptions = {}) {
    this.register = opts.register ?? new Registry();
    this.prefix = opts.prefix ?? "queue_consumer_pool";

    // Current state metrics
    this.consumerCount = new Gauge({
      name: `${this.prefix}_consumer_count`,
      help: "Current number of active queue consumers",
      labelNames: ["strategy"],
      registers: [this.register],
    });

    this.queueLength = new Gauge({
      name: `${this.prefix}_queue_length`,
      help: "Current queue length (median of recent samples)",
      registers: [this.register],
    });

    this.smoothedQueueLength = new Gauge({
      name: `${this.prefix}_smoothed_queue_length`,
      help: "EWMA smoothed queue length",
      registers: [this.register],
    });

    this.targetConsumerCount = new Gauge({
      name: `${this.prefix}_target_consumer_count`,
      help: "Target number of consumers calculated by scaling strategy",
      labelNames: ["strategy"],
      registers: [this.register],
    });

    this.scalingStrategy = new Gauge({
      name: `${this.prefix}_scaling_strategy_info`,
      help: "Information about the active scaling strategy (1 = active, 0 = inactive)",
      labelNames: ["strategy"],
      registers: [this.register],
    });

    // Scaling operation metrics
    this.scalingOperationsTotal = new Counter({
      name: `${this.prefix}_scaling_operations_total`,
      help: "Total number of scaling operations performed",
      labelNames: ["direction", "strategy"],
      registers: [this.register],
    });

    this.consumersAddedTotal = new Counter({
      name: `${this.prefix}_consumers_added_total`,
      help: "Total number of consumers added",
      registers: [this.register],
    });

    this.consumersRemovedTotal = new Counter({
      name: `${this.prefix}_consumers_removed_total`,
      help: "Total number of consumers removed",
      registers: [this.register],
    });

    this.scalingCooldownsApplied = new Counter({
      name: `${this.prefix}_scaling_cooldowns_applied_total`,
      help: "Number of times scaling was prevented due to cooldown",
      labelNames: ["direction"],
      registers: [this.register],
    });

    this.queueLengthUpdatesTotal = new Counter({
      name: `${this.prefix}_queue_length_updates_total`,
      help: "Total number of queue length updates received",
      registers: [this.register],
    });

    this.batchesProcessedTotal = new Counter({
      name: `${this.prefix}_batches_processed_total`,
      help: "Total number of metric batches processed",
      registers: [this.register],
    });
  }

  /**
   * Update all gauge metrics with current state
   */
  updateState(state: {
    consumerCount: number;
    queueLength?: number;
    smoothedQueueLength: number;
    targetConsumerCount: number;
    strategy: string;
  }) {
    this.consumerCount.set({ strategy: state.strategy }, state.consumerCount);

    if (state.queueLength !== undefined) {
      this.queueLength.set(state.queueLength);
    }

    this.smoothedQueueLength.set(state.smoothedQueueLength);
    this.targetConsumerCount.set({ strategy: state.strategy }, state.targetConsumerCount);

    // Set strategy info (1 for active strategy, 0 for others)
    ["none", "smooth", "aggressive"].forEach((s) => {
      this.scalingStrategy.set({ strategy: s }, s === state.strategy ? 1 : 0);
    });
  }

  /**
   * Record a scaling operation
   */
  recordScalingOperation(direction: "up" | "down" | "none", strategy: string, count: number) {
    if (direction !== "none") {
      this.scalingOperationsTotal.inc({ direction, strategy });

      if (direction === "up") {
        this.consumersAddedTotal.inc(count);
      } else {
        this.consumersRemovedTotal.inc(count);
      }
    }
  }

  /**
   * Record that scaling was prevented by cooldown
   */
  recordCooldownApplied(direction: "up" | "down") {
    this.scalingCooldownsApplied.inc({ direction });
  }

  /**
   * Record a queue length update
   */
  recordQueueLengthUpdate() {
    this.queueLengthUpdatesTotal.inc();
  }
}
