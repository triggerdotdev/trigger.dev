import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  ObservableGauge,
  Span,
  SpanKind,
  SpanOptions,
  Tracer,
  Context,
} from "@internal/tracing";
import { context, trace, SpanStatusCode, ROOT_CONTEXT } from "@internal/tracing";

/**
 * Semantic attributes for fair queue messaging operations.
 */
export const FairQueueAttributes = {
  QUEUE_ID: "fairqueue.queue_id",
  TENANT_ID: "fairqueue.tenant_id",
  MESSAGE_ID: "fairqueue.message_id",
  SHARD_ID: "fairqueue.shard_id",
  WORKER_QUEUE: "fairqueue.worker_queue",
  CONSUMER_ID: "fairqueue.consumer_id",
  ATTEMPT: "fairqueue.attempt",
  CONCURRENCY_GROUP: "fairqueue.concurrency_group",
  MESSAGE_COUNT: "fairqueue.message_count",
  RESULT: "fairqueue.result",
} as const;

/**
 * Standard messaging semantic attributes.
 */
export const MessagingAttributes = {
  SYSTEM: "messaging.system",
  OPERATION: "messaging.operation",
  MESSAGE_ID: "messaging.message_id",
  DESTINATION_NAME: "messaging.destination.name",
} as const;

/**
 * FairQueue metrics collection.
 */
export interface FairQueueMetrics {
  // Counters
  messagesEnqueued: Counter;
  messagesCompleted: Counter;
  messagesFailed: Counter;
  messagesRetried: Counter;
  messagesToDLQ: Counter;

  // Histograms
  processingTime: Histogram;
  queueTime: Histogram;

  // Observable gauges (registered with callbacks)
  queueLength: ObservableGauge;
  masterQueueLength: ObservableGauge;
  inflightCount: ObservableGauge;
  dlqLength: ObservableGauge;
}

/**
 * Options for creating FairQueue telemetry.
 */
export interface TelemetryOptions {
  tracer?: Tracer;
  meter?: Meter;
  /** Custom name for metrics prefix */
  name?: string;
}

/**
 * Telemetry helper for FairQueue.
 *
 * Provides:
 * - Span creation with proper attributes
 * - Metric recording
 * - Context propagation helpers
 */
export class FairQueueTelemetry {
  private tracer?: Tracer;
  private meter?: Meter;
  private metrics?: FairQueueMetrics;
  private name: string;

  constructor(options: TelemetryOptions) {
    this.tracer = options.tracer;
    this.meter = options.meter;
    this.name = options.name ?? "fairqueue";

    if (this.meter) {
      this.#initializeMetrics();
    }
  }

  // ============================================================================
  // Tracing
  // ============================================================================

  /**
   * Create a traced span for an operation.
   * Returns the result of the function, or throws any error after recording it.
   */
  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: {
      kind?: SpanKind;
      attributes?: Attributes;
    }
  ): Promise<T> {
    if (!this.tracer) {
      // No tracer, just execute the function with a no-op span
      return fn(noopSpan);
    }

    const spanOptions: SpanOptions = {
      kind: options?.kind,
      attributes: {
        [MessagingAttributes.SYSTEM]: this.name,
        ...options?.attributes,
      },
    };

    return this.tracer.startActiveSpan(`${this.name}.${name}`, spanOptions, async (span) => {
      try {
        const result = await fn(span);
        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
        } else {
          span.recordException(new Error(String(error)));
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Synchronous version of trace.
   */
  traceSync<T>(
    name: string,
    fn: (span: Span) => T,
    options?: {
      kind?: SpanKind;
      attributes?: Attributes;
    }
  ): T {
    if (!this.tracer) {
      return fn(noopSpan);
    }

    const spanOptions: SpanOptions = {
      kind: options?.kind,
      attributes: {
        [MessagingAttributes.SYSTEM]: this.name,
        ...options?.attributes,
      },
    };

    return this.tracer.startActiveSpan(`${this.name}.${name}`, spanOptions, (span) => {
      try {
        return fn(span);
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
        } else {
          span.recordException(new Error(String(error)));
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ============================================================================
  // Metrics
  // ============================================================================

  /**
   * Record a message enqueued.
   */
  recordEnqueue(attributes?: Attributes): void {
    this.metrics?.messagesEnqueued.add(1, attributes);
  }

  /**
   * Record a batch of messages enqueued.
   */
  recordEnqueueBatch(count: number, attributes?: Attributes): void {
    this.metrics?.messagesEnqueued.add(count, attributes);
  }

  /**
   * Record a message completed successfully.
   */
  recordComplete(attributes?: Attributes): void {
    this.metrics?.messagesCompleted.add(1, attributes);
  }

  /**
   * Record a message processing failure.
   */
  recordFailure(attributes?: Attributes): void {
    this.metrics?.messagesFailed.add(1, attributes);
  }

  /**
   * Record a message retry.
   */
  recordRetry(attributes?: Attributes): void {
    this.metrics?.messagesRetried.add(1, attributes);
  }

  /**
   * Record a message sent to DLQ.
   */
  recordDLQ(attributes?: Attributes): void {
    this.metrics?.messagesToDLQ.add(1, attributes);
  }

  /**
   * Record message processing time.
   *
   * @param durationMs - Processing duration in milliseconds
   */
  recordProcessingTime(durationMs: number, attributes?: Attributes): void {
    this.metrics?.processingTime.record(durationMs, attributes);
  }

  /**
   * Record time a message spent waiting in queue.
   *
   * @param durationMs - Queue wait time in milliseconds
   */
  recordQueueTime(durationMs: number, attributes?: Attributes): void {
    this.metrics?.queueTime.record(durationMs, attributes);
  }

  /**
   * Register observable gauge callbacks.
   * Call this after FairQueue is initialized to register the gauge callbacks.
   */
  registerGaugeCallbacks(callbacks: {
    getQueueLength?: (queueId: string) => Promise<number>;
    getMasterQueueLength?: (shardId: number) => Promise<number>;
    getInflightCount?: (shardId: number) => Promise<number>;
    getDLQLength?: (tenantId: string) => Promise<number>;
    shardCount?: number;
    observedQueues?: string[];
    observedTenants?: string[];
  }): void {
    if (!this.metrics) return;

    // Queue length gauge
    if (callbacks.getQueueLength && callbacks.observedQueues) {
      const getQueueLength = callbacks.getQueueLength;
      const queues = callbacks.observedQueues;

      this.metrics.queueLength.addCallback(async (observableResult) => {
        for (const queueId of queues) {
          const length = await getQueueLength(queueId);
          observableResult.observe(length, {
            [FairQueueAttributes.QUEUE_ID]: queueId,
          });
        }
      });
    }

    // Master queue length gauge
    if (callbacks.getMasterQueueLength && callbacks.shardCount) {
      const getMasterQueueLength = callbacks.getMasterQueueLength;
      const shardCount = callbacks.shardCount;

      this.metrics.masterQueueLength.addCallback(async (observableResult) => {
        for (let shardId = 0; shardId < shardCount; shardId++) {
          const length = await getMasterQueueLength(shardId);
          observableResult.observe(length, {
            [FairQueueAttributes.SHARD_ID]: shardId.toString(),
          });
        }
      });
    }

    // Inflight count gauge
    if (callbacks.getInflightCount && callbacks.shardCount) {
      const getInflightCount = callbacks.getInflightCount;
      const shardCount = callbacks.shardCount;

      this.metrics.inflightCount.addCallback(async (observableResult) => {
        for (let shardId = 0; shardId < shardCount; shardId++) {
          const count = await getInflightCount(shardId);
          observableResult.observe(count, {
            [FairQueueAttributes.SHARD_ID]: shardId.toString(),
          });
        }
      });
    }

    // DLQ length gauge
    if (callbacks.getDLQLength && callbacks.observedTenants) {
      const getDLQLength = callbacks.getDLQLength;
      const tenants = callbacks.observedTenants;

      this.metrics.dlqLength.addCallback(async (observableResult) => {
        for (const tenantId of tenants) {
          const length = await getDLQLength(tenantId);
          observableResult.observe(length, {
            [FairQueueAttributes.TENANT_ID]: tenantId,
          });
        }
      });
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Create standard attributes for a message operation (for spans/traces).
   * Use this for span attributes where high cardinality is acceptable.
   */
  messageAttributes(params: {
    queueId?: string;
    tenantId?: string;
    messageId?: string;
    attempt?: number;
    workerQueue?: string;
    consumerId?: string;
  }): Attributes {
    const attrs: Attributes = {};

    if (params.queueId) attrs[FairQueueAttributes.QUEUE_ID] = params.queueId;
    if (params.tenantId) attrs[FairQueueAttributes.TENANT_ID] = params.tenantId;
    if (params.messageId) attrs[FairQueueAttributes.MESSAGE_ID] = params.messageId;
    if (params.attempt !== undefined) attrs[FairQueueAttributes.ATTEMPT] = params.attempt;
    if (params.workerQueue) attrs[FairQueueAttributes.WORKER_QUEUE] = params.workerQueue;
    if (params.consumerId) attrs[FairQueueAttributes.CONSUMER_ID] = params.consumerId;

    return attrs;
  }

  /**
   * Check if telemetry is enabled.
   */
  get isEnabled(): boolean {
    return !!this.tracer || !!this.meter;
  }

  /**
   * Check if tracing is enabled.
   */
  get hasTracer(): boolean {
    return !!this.tracer;
  }

  /**
   * Check if metrics are enabled.
   */
  get hasMetrics(): boolean {
    return !!this.meter;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  #initializeMetrics(): void {
    if (!this.meter) return;

    this.metrics = {
      // Counters
      messagesEnqueued: this.meter.createCounter(`${this.name}.messages.enqueued`, {
        description: "Number of messages enqueued",
        unit: "messages",
      }),
      messagesCompleted: this.meter.createCounter(`${this.name}.messages.completed`, {
        description: "Number of messages completed successfully",
        unit: "messages",
      }),
      messagesFailed: this.meter.createCounter(`${this.name}.messages.failed`, {
        description: "Number of messages that failed processing",
        unit: "messages",
      }),
      messagesRetried: this.meter.createCounter(`${this.name}.messages.retried`, {
        description: "Number of message retries",
        unit: "messages",
      }),
      messagesToDLQ: this.meter.createCounter(`${this.name}.messages.dlq`, {
        description: "Number of messages sent to dead letter queue",
        unit: "messages",
      }),

      // Histograms
      processingTime: this.meter.createHistogram(`${this.name}.message.processing_time`, {
        description: "Message processing time",
        unit: "ms",
      }),
      queueTime: this.meter.createHistogram(`${this.name}.message.queue_time`, {
        description: "Time message spent waiting in queue",
        unit: "ms",
      }),

      // Observable gauges
      queueLength: this.meter.createObservableGauge(`${this.name}.queue.length`, {
        description: "Number of messages in a queue",
        unit: "messages",
      }),
      masterQueueLength: this.meter.createObservableGauge(`${this.name}.master_queue.length`, {
        description: "Number of queues in master queue shard",
        unit: "queues",
      }),
      inflightCount: this.meter.createObservableGauge(`${this.name}.inflight.count`, {
        description: "Number of messages currently being processed",
        unit: "messages",
      }),
      dlqLength: this.meter.createObservableGauge(`${this.name}.dlq.length`, {
        description: "Number of messages in dead letter queue",
        unit: "messages",
      }),
    };
  }
}

// ============================================================================
// Batched Span Manager
// ============================================================================

/**
 * State for tracking a consumer loop's batched span.
 */
export interface ConsumerLoopState {
  /** Countdown of iterations before starting a new span */
  perTraceCountdown: number;
  /** When the current trace started */
  traceStartedAt: Date;
  /** The current batched span */
  currentSpan?: Span;
  /** The context for the current batched span */
  currentSpanContext?: Context;
  /** Number of iterations in the current span */
  iterationsCount: number;
  /** Total iterations across all spans */
  totalIterationsCount: number;
  /** Running duration in milliseconds for the current span */
  runningDurationInMs: number;
  /** Stats counters for the current span */
  stats: Record<string, number>;
  /** Flag to force span end on next iteration */
  endSpanInNextIteration: boolean;
}

/**
 * Configuration for the BatchedSpanManager.
 */
export interface BatchedSpanManagerOptions {
  /** The tracer to use for creating spans */
  tracer?: Tracer;
  /** Name prefix for spans */
  name: string;
  /** Maximum iterations before rotating the span */
  maxIterations: number;
  /** Maximum seconds before rotating the span */
  timeoutSeconds: number;
  /** Optional callback to get dynamic attributes when starting a new batched span */
  getDynamicAttributes?: () => Attributes;
}

/**
 * Manages batched spans for consumer loops.
 *
 * This allows multiple iterations to be grouped into a single parent span,
 * reducing the volume of spans while maintaining observability.
 */
export class BatchedSpanManager {
  private tracer?: Tracer;
  private name: string;
  private maxIterations: number;
  private timeoutSeconds: number;
  private loopStates = new Map<string, ConsumerLoopState>();
  private getDynamicAttributes?: () => Attributes;

  constructor(options: BatchedSpanManagerOptions) {
    this.tracer = options.tracer;
    this.name = options.name;
    this.maxIterations = options.maxIterations;
    this.timeoutSeconds = options.timeoutSeconds;
    this.getDynamicAttributes = options.getDynamicAttributes;
  }

  /**
   * Initialize state for a consumer loop.
   */
  initializeLoop(loopId: string): void {
    this.loopStates.set(loopId, {
      perTraceCountdown: this.maxIterations,
      traceStartedAt: new Date(),
      iterationsCount: 0,
      totalIterationsCount: 0,
      runningDurationInMs: 0,
      stats: {},
      endSpanInNextIteration: false,
    });
  }

  /**
   * Get the state for a consumer loop.
   */
  getState(loopId: string): ConsumerLoopState | undefined {
    return this.loopStates.get(loopId);
  }

  /**
   * Increment a stat counter for a loop.
   */
  incrementStat(loopId: string, statName: string, value: number = 1): void {
    const state = this.loopStates.get(loopId);
    if (state) {
      state.stats[statName] = (state.stats[statName] ?? 0) + value;
    }
  }

  /**
   * Mark that the span should end on the next iteration.
   */
  markForRotation(loopId: string): void {
    const state = this.loopStates.get(loopId);
    if (state) {
      state.endSpanInNextIteration = true;
    }
  }

  /**
   * Check if the span should be rotated (ended and a new one started).
   */
  shouldRotate(loopId: string): boolean {
    const state = this.loopStates.get(loopId);
    if (!state) return true;

    return (
      state.perTraceCountdown <= 0 ||
      Date.now() - state.traceStartedAt.getTime() > this.timeoutSeconds * 1000 ||
      state.currentSpanContext === undefined ||
      state.endSpanInNextIteration
    );
  }

  /**
   * End the current span for a loop and record stats.
   */
  endCurrentSpan(loopId: string): void {
    const state = this.loopStates.get(loopId);
    if (!state?.currentSpan) return;

    // Record stats as span attributes
    for (const [statName, count] of Object.entries(state.stats)) {
      state.currentSpan.setAttribute(`stats.${statName}`, count);
    }

    state.currentSpan.end();
    state.currentSpan = undefined;
    state.currentSpanContext = undefined;
  }

  /**
   * Start a new batched span for a loop.
   */
  startNewSpan(loopId: string, attributes?: Attributes): void {
    if (!this.tracer) return;

    const state = this.loopStates.get(loopId);
    if (!state) return;

    // End any existing span first
    this.endCurrentSpan(loopId);

    // Calculate metrics from previous span period
    const traceDurationInMs = state.traceStartedAt
      ? Date.now() - state.traceStartedAt.getTime()
      : undefined;
    const iterationsPerSecond =
      traceDurationInMs && traceDurationInMs > 0
        ? state.iterationsCount / (traceDurationInMs / 1000)
        : undefined;

    // Get dynamic attributes if callback is provided
    const dynamicAttributes = this.getDynamicAttributes?.() ?? {};

    // Start new span
    state.currentSpan = this.tracer.startSpan(
      `${this.name}.consumerLoop`,
      {
        kind: 1, // SpanKind.CONSUMER
        attributes: {
          loop_id: loopId,
          max_iterations: this.maxIterations,
          timeout_seconds: this.timeoutSeconds,
          previous_iterations: state.iterationsCount,
          previous_duration_ms: traceDurationInMs,
          previous_iterations_per_second: iterationsPerSecond,
          total_iterations: state.totalIterationsCount,
          ...dynamicAttributes,
          ...attributes,
        },
      },
      ROOT_CONTEXT
    );

    // Set up context for child spans
    state.currentSpanContext = trace.setSpan(ROOT_CONTEXT, state.currentSpan);

    // Reset counters
    state.perTraceCountdown = this.maxIterations;
    state.traceStartedAt = new Date();
    state.iterationsCount = 0;
    state.runningDurationInMs = 0;
    state.stats = {};
    state.endSpanInNextIteration = false;
  }

  /**
   * Execute a function within the batched span context.
   * Automatically handles span rotation and iteration tracking.
   */
  async withBatchedSpan<T>(
    loopId: string,
    fn: (span: Span) => Promise<T>,
    options?: {
      iterationSpanName?: string;
      attributes?: Attributes;
    }
  ): Promise<T> {
    let state = this.loopStates.get(loopId);

    // Initialize state if not present
    if (!state) {
      this.initializeLoop(loopId);
      state = this.loopStates.get(loopId)!;
    }

    // Check if we need to rotate the span
    if (this.shouldRotate(loopId)) {
      this.startNewSpan(loopId);
    }

    const startTime = performance.now();

    try {
      // If no tracer, just execute the function
      if (!this.tracer || !state.currentSpanContext) {
        return await fn(noopSpan);
      }

      // Execute within the batched span context
      return await context.with(state.currentSpanContext, async () => {
        // Create an iteration span within the batched span
        const iterationSpanName = options?.iterationSpanName ?? "iteration";

        return await this.tracer!.startActiveSpan(
          `${this.name}.${iterationSpanName}`,
          {
            attributes: {
              loop_id: loopId,
              iteration: state.iterationsCount,
              ...options?.attributes,
            },
          },
          async (iterationSpan) => {
            try {
              return await fn(iterationSpan);
            } catch (error) {
              if (error instanceof Error) {
                iterationSpan.recordException(error);
                state.currentSpan?.recordException(error);
              }
              iterationSpan.setStatus({ code: SpanStatusCode.ERROR });
              state.endSpanInNextIteration = true;
              throw error;
            } finally {
              iterationSpan.end();
            }
          }
        );
      });
    } finally {
      // Update iteration tracking
      const duration = performance.now() - startTime;
      state.runningDurationInMs += duration;
      state.iterationsCount++;
      state.totalIterationsCount++;
      state.perTraceCountdown--;
    }
  }

  /**
   * Clean up state for a loop when it's stopped.
   */
  cleanup(loopId: string): void {
    this.endCurrentSpan(loopId);
    this.loopStates.delete(loopId);
  }

  /**
   * Clean up all loop states.
   */
  cleanupAll(): void {
    for (const loopId of this.loopStates.keys()) {
      this.cleanup(loopId);
    }
  }
}

/**
 * No-op span implementation for when telemetry is disabled.
 */
const noopSpan: Span = {
  spanContext: () => ({
    traceId: "",
    spanId: "",
    traceFlags: 0,
  }),
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  addLink: () => noopSpan,
  addLinks: () => noopSpan,
  setStatus: () => noopSpan,
  updateName: () => noopSpan,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
};

/**
 * No-op telemetry instance for when telemetry is disabled.
 */
export const noopTelemetry = new FairQueueTelemetry({});
