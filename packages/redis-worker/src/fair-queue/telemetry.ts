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
} from "@internal/tracing";

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
   * Create standard attributes for a message operation.
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
