import { EventEmitter } from "node:stream";
import type { ClickHouse } from "@internal/clickhouse";
import type {
  IEventRepository,
  CreatableEvent,
  CompleteableTaskRun,
  TraceEventOptions,
  EventBuilder,
  TraceSummary,
  TraceDetailedSummary,
  RunPreparedEvent,
  TaskEventRecord,
  ExceptionEventProperties,
} from "./eventRepository.types";
import type { TaskEventStoreTable } from "./taskEventStore.server";
import type { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";

export type ClickhouseEventRepositoryConfig = {
  clickhouse: ClickHouse;
  batchSize?: number;
  flushInterval?: number;
};

/**
 * ClickHouse-based implementation of the EventRepository.
 * This implementation stores events in ClickHouse for better analytics and performance.
 */
export class ClickhouseEventRepository implements IEventRepository {
  private _subscriberCount = 0;
  private _clickhouse: ClickHouse;
  private _config: ClickhouseEventRepositoryConfig;

  constructor(config: ClickhouseEventRepositoryConfig) {
    this._clickhouse = config.clickhouse;
    this._config = config;
  }

  // Properties
  get subscriberCount(): number {
    return this._subscriberCount;
  }

  // Event insertion methods
  async insert(event: CreatableEvent): Promise<void> {
    throw new Error("ClickhouseEventRepository.insert not implemented");
  }

  async insertImmediate(event: CreatableEvent): Promise<void> {
    throw new Error("ClickhouseEventRepository.insertImmediate not implemented");
  }

  async insertMany(events: CreatableEvent[]): Promise<void> {
    throw new Error("ClickhouseEventRepository.insertMany not implemented");
  }

  async insertManyImmediate(events: CreatableEvent[]): Promise<CreatableEvent[]> {
    throw new Error("ClickhouseEventRepository.insertManyImmediate not implemented");
  }

  // Run event completion methods
  async completeSuccessfulRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.completeSuccessfulRunEvent not implemented");
  }

  async completeCachedRunEvent(params: {
    run: CompleteableTaskRun;
    blockedRun: CompleteableTaskRun;
    spanId: string;
    parentSpanId: string;
    spanCreatedAt: Date;
    isError: boolean;
    endTime?: Date;
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.completeCachedRunEvent not implemented");
  }

  async completeFailedRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
    exception: { message?: string; type?: string; stacktrace?: string };
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.completeFailedRunEvent not implemented");
  }

  async completeExpiredRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
    ttl: string;
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.completeExpiredRunEvent not implemented");
  }

  async createAttemptFailedRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
    attemptNumber: number;
    exception: { message?: string; type?: string; stacktrace?: string };
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.createAttemptFailedRunEvent not implemented");
  }

  async cancelRunEvent(params: {
    reason: string;
    run: CompleteableTaskRun;
    cancelledAt: Date;
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.cancelRunEvent not implemented");
  }

  async crashEvent(params: {
    event: TaskEventRecord;
    crashedAt: Date;
    exception: ExceptionEventProperties;
  }): Promise<void> {
    throw new Error("ClickhouseEventRepository.crashEvent not implemented");
  }

  // Query methods
  async getTraceSummary(
    storeTable: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceSummary | undefined> {
    throw new Error("ClickhouseEventRepository.getTraceSummary not implemented");
  }

  async getTraceDetailedSummary(
    storeTable: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceDetailedSummary | undefined> {
    throw new Error("ClickhouseEventRepository.getTraceDetailedSummary not implemented");
  }

  async getRunEvents(
    storeTable: TaskEventStoreTable,
    runId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<RunPreparedEvent[]> {
    throw new Error("ClickhouseEventRepository.getRunEvents not implemented");
  }

  async getSpan(
    storeTable: TaskEventStoreTable,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<any> {
    throw new Error("ClickhouseEventRepository.getSpan not implemented");
  }

  // Event recording methods
  async recordEvent(
    message: string,
    options: TraceEventOptions & { duration?: number; parentId?: string }
  ): Promise<CreatableEvent> {
    throw new Error("ClickhouseEventRepository.recordEvent not implemented");
  }

  async traceEvent<TResult>(
    message: string,
    options: TraceEventOptions & { incomplete?: boolean; isError?: boolean },
    callback: (
      e: EventBuilder,
      traceContext: Record<string, string | undefined>,
      traceparent?: { traceId: string; spanId: string }
    ) => Promise<TResult>
  ): Promise<TResult> {
    throw new Error("ClickhouseEventRepository.traceEvent not implemented");
  }

  // Subscription methods
  async subscribeToTrace(traceId: string): Promise<{
    unsubscribe: () => Promise<void>;
    eventEmitter: EventEmitter;
  }> {
    throw new Error("ClickhouseEventRepository.subscribeToTrace not implemented");
  }

  // ID generation methods
  generateTraceId(): string {
    throw new Error("ClickhouseEventRepository.generateTraceId not implemented");
  }

  generateSpanId(): string {
    throw new Error("ClickhouseEventRepository.generateSpanId not implemented");
  }
}

/**
 * Factory function to create a ClickhouseEventRepository instance.
 * This can be used as an alternative to the PostgreSQL-based EventRepository.
 */
export function createClickhouseEventRepository(
  config: ClickhouseEventRepositoryConfig
): IEventRepository {
  return new ClickhouseEventRepository(config);
}
