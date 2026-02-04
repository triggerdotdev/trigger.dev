import type { ClickHouse, TaskRunInsertArray, PayloadInsertArray } from "@internal/clickhouse";
import { getTaskRunField, getPayloadField } from "@internal/clickhouse";
import { type RedisOptions } from "@internal/redis";
import {
  LogicalReplicationClient,
  type MessageDelete,
  type MessageInsert,
  type MessageUpdate,
  type PgoutputMessage,
} from "@internal/replication";
import {
  getMeter,
  recordSpanError,
  startSpan,
  trace,
  type Counter,
  type Histogram,
  type Meter,
  type Tracer,
} from "@internal/tracing";
import { Logger, type LogLevel } from "@trigger.dev/core/logger";
import { tryCatch } from "@trigger.dev/core/utils";
import { parsePacketAsJson } from "@trigger.dev/core/v3/utils/ioSerialization";
import { unsafeExtractIdempotencyKeyScope, unsafeExtractIdempotencyKeyUser } from "@trigger.dev/core/v3/serverOnly";
import { type TaskRun } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import EventEmitter from "node:events";
import pLimit from "p-limit";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";

interface TransactionEvent<T = any> {
  tag: "insert" | "update" | "delete";
  data: T;
  raw: MessageInsert | MessageUpdate | MessageDelete;
}

interface Transaction<T = any> {
  beginStartTimestamp: number;
  commitLsn: string | null;
  commitEndLsn: string | null;
  xid: number;
  events: TransactionEvent<T>[];
  replicationLagMs: number;
}

export type RunsReplicationServiceOptions = {
  clickhouse: ClickHouse;
  pgConnectionUrl: string;
  serviceName: string;
  slotName: string;
  publicationName: string;
  redisOptions: RedisOptions;
  maxFlushConcurrency?: number;
  flushIntervalMs?: number;
  flushBatchSize?: number;
  leaderLockTimeoutMs?: number;
  leaderLockExtendIntervalMs?: number;
  leaderLockAcquireAdditionalTimeMs?: number;
  leaderLockRetryIntervalMs?: number;
  ackIntervalSeconds?: number;
  acknowledgeTimeoutMs?: number;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
  meter?: Meter;
  waitForAsyncInsert?: boolean;
  insertStrategy?: "insert" | "insert_async";
  // Retry configuration for insert operations
  insertMaxRetries?: number;
  insertBaseDelayMs?: number;
  insertMaxDelayMs?: number;
  disablePayloadInsert?: boolean;
};

type PostgresTaskRun = TaskRun & { masterQueue: string };

type TaskRunInsert = {
  _version: bigint;
  run: PostgresTaskRun;
  event: "insert" | "update" | "delete";
};

export type RunsReplicationServiceEvents = {
  message: [{ lsn: string; message: PgoutputMessage; service: RunsReplicationService }];
  batchFlushed: [
    { flushId: string; taskRunInserts: TaskRunInsertArray[]; payloadInserts: PayloadInsertArray[] }
  ];
};

export class RunsReplicationService {
  private _isSubscribed = false;
  private _currentTransaction:
    | (Omit<Transaction<TaskRun>, "commitEndLsn" | "replicationLagMs"> & {
        commitEndLsn?: string | null;
        replicationLagMs?: number;
      })
    | null = null;

  private _replicationClient: LogicalReplicationClient;
  private _concurrentFlushScheduler: ConcurrentFlushScheduler<TaskRunInsert>;
  private logger: Logger;
  private _isShuttingDown = false;
  private _isShutDownComplete = false;
  private _tracer: Tracer;
  private _meter: Meter;
  private _currentParseDurationMs: number | null = null;
  private _lastAcknowledgedAt: number | null = null;
  private _acknowledgeTimeoutMs: number;
  private _latestCommitEndLsn: string | null = null;
  private _lastAcknowledgedLsn: string | null = null;
  private _acknowledgeInterval: NodeJS.Timeout | null = null;
  // Retry configuration
  private _insertMaxRetries: number;
  private _insertBaseDelayMs: number;
  private _insertMaxDelayMs: number;
  private _insertStrategy: "insert" | "insert_async";
  private _disablePayloadInsert: boolean;

  // Metrics
  private _replicationLagHistogram: Histogram;
  private _batchesFlushedCounter: Counter;
  private _batchSizeHistogram: Histogram;
  private _taskRunsInsertedCounter: Counter;
  private _payloadsInsertedCounter: Counter;
  private _insertRetriesCounter: Counter;
  private _eventsProcessedCounter: Counter;
  private _flushDurationHistogram: Histogram;

  public readonly events: EventEmitter<RunsReplicationServiceEvents>;

  constructor(private readonly options: RunsReplicationServiceOptions) {
    this.logger =
      options.logger ?? new Logger("RunsReplicationService", options.logLevel ?? "info");
    this.events = new EventEmitter();
    this._tracer = options.tracer ?? trace.getTracer("runs-replication-service");
    this._meter = options.meter ?? getMeter("runs-replication");

    // Initialize metrics
    this._replicationLagHistogram = this._meter.createHistogram(
      "runs_replication.replication_lag_ms",
      {
        description: "Replication lag from Postgres commit to processing",
        unit: "ms",
      }
    );

    this._batchesFlushedCounter = this._meter.createCounter("runs_replication.batches_flushed", {
      description: "Total batches flushed to ClickHouse",
    });

    this._batchSizeHistogram = this._meter.createHistogram("runs_replication.batch_size", {
      description: "Number of items per batch flush",
      unit: "items",
    });

    this._taskRunsInsertedCounter = this._meter.createCounter(
      "runs_replication.task_runs_inserted",
      {
        description: "Task run inserts to ClickHouse",
        unit: "inserts",
      }
    );

    this._payloadsInsertedCounter = this._meter.createCounter(
      "runs_replication.payloads_inserted",
      {
        description: "Payload inserts to ClickHouse",
        unit: "inserts",
      }
    );

    this._insertRetriesCounter = this._meter.createCounter("runs_replication.insert_retries", {
      description: "Insert retry attempts",
    });

    this._eventsProcessedCounter = this._meter.createCounter("runs_replication.events_processed", {
      description: "Replication events processed (inserts, updates, deletes)",
    });

    this._flushDurationHistogram = this._meter.createHistogram(
      "runs_replication.flush_duration_ms",
      {
        description: "Duration of batch flush operations",
        unit: "ms",
      }
    );

    this._acknowledgeTimeoutMs = options.acknowledgeTimeoutMs ?? 1_000;

    this._insertStrategy = options.insertStrategy ?? "insert";
    this._disablePayloadInsert = options.disablePayloadInsert ?? false;

    this._replicationClient = new LogicalReplicationClient({
      pgConfig: {
        connectionString: options.pgConnectionUrl,
      },
      name: options.serviceName,
      slotName: options.slotName,
      publicationName: options.publicationName,
      table: "TaskRun",
      redisOptions: options.redisOptions,
      autoAcknowledge: false,
      publicationActions: ["insert", "update", "delete"],
      logger: options.logger ?? new Logger("LogicalReplicationClient", options.logLevel ?? "info"),
      leaderLockTimeoutMs: options.leaderLockTimeoutMs ?? 30_000,
      leaderLockExtendIntervalMs: options.leaderLockExtendIntervalMs ?? 10_000,
      ackIntervalSeconds: options.ackIntervalSeconds ?? 10,
      leaderLockAcquireAdditionalTimeMs: options.leaderLockAcquireAdditionalTimeMs ?? 10_000,
      leaderLockRetryIntervalMs: options.leaderLockRetryIntervalMs ?? 500,
      tracer: options.tracer,
    });

    this._concurrentFlushScheduler = new ConcurrentFlushScheduler<TaskRunInsert>({
      batchSize: options.flushBatchSize ?? 50,
      flushInterval: options.flushIntervalMs ?? 100,
      maxConcurrency: options.maxFlushConcurrency ?? 100,
      callback: this.#flushBatch.bind(this),
      // Key-based deduplication to reduce duplicates sent to ClickHouse
      getKey: (item) => {
        if (!item?.run?.id) {
          this.logger.warn("Skipping replication event with null run", { event: item });
          return null;
        }
        return `${item.event}_${item.run.id}`;
      },
      // Keep the run with the higher version (latest)
      // and take the last occurrence for that version.
      // Items originating from the same DB transaction have the same version.
      shouldReplace: (existing, incoming) => incoming._version >= existing._version,
      logger: new Logger("ConcurrentFlushScheduler", options.logLevel ?? "info"),
      tracer: options.tracer,
    });

    this._replicationClient.events.on("data", async ({ lsn, log, parseDuration }) => {
      this.#handleData(lsn, log, parseDuration);
    });

    this._replicationClient.events.on("heartbeat", async ({ lsn, shouldRespond }) => {
      if (this._isShuttingDown) return;
      if (this._isShutDownComplete) return;

      if (shouldRespond) {
        this._lastAcknowledgedLsn = lsn;
        await this._replicationClient.acknowledge(lsn);
      }
    });

    this._replicationClient.events.on("error", (error) => {
      this.logger.error("Replication client error", {
        error,
      });
    });

    this._replicationClient.events.on("start", () => {
      this.logger.info("Replication client started");
    });

    this._replicationClient.events.on("acknowledge", ({ lsn }) => {
      this.logger.debug("Acknowledged", { lsn });
    });

    this._replicationClient.events.on("leaderElection", (isLeader) => {
      this.logger.info("Leader election", { isLeader });
    });

    // Initialize retry configuration
    this._insertMaxRetries = options.insertMaxRetries ?? 3;
    this._insertBaseDelayMs = options.insertBaseDelayMs ?? 100;
    this._insertMaxDelayMs = options.insertMaxDelayMs ?? 2000;
  }

  public async shutdown() {
    if (this._isShuttingDown) return;

    this._isShuttingDown = true;

    this.logger.info("Initiating shutdown of runs replication service");

    if (!this._currentTransaction) {
      this.logger.info("No transaction to commit, shutting down immediately");
      await this._replicationClient.stop();
      this._isShutDownComplete = true;
      return;
    }

    this._concurrentFlushScheduler.shutdown();
  }

  async start() {
    this.logger.info("Starting replication client", {
      lastLsn: this._latestCommitEndLsn,
    });

    await this._replicationClient.subscribe(this._latestCommitEndLsn ?? undefined);

    this._acknowledgeInterval = setInterval(this.#acknowledgeLatestTransaction.bind(this), 1000);
    this._concurrentFlushScheduler.start();
  }

  async stop() {
    this.logger.info("Stopping replication client");

    await this._replicationClient.stop();

    if (this._acknowledgeInterval) {
      clearInterval(this._acknowledgeInterval);
    }
  }

  async teardown() {
    this.logger.info("Teardown replication client");

    await this._replicationClient.teardown();

    if (this._acknowledgeInterval) {
      clearInterval(this._acknowledgeInterval);
    }
  }

  async backfill(runs: PostgresTaskRun[]) {
    // divide into batches of 50 to get data from Postgres
    const flushId = nanoid();
    // Use current timestamp as LSN (high enough to be above existing data)
    const now = Date.now();
    const syntheticLsn = `${now.toString(16).padStart(8, "0").toUpperCase()}/00000000`;
    const baseVersion = lsnToUInt64(syntheticLsn);

    await this.#flushBatch(
      flushId,
      runs.map((run, index) => ({
        _version: baseVersion + BigInt(index),
        run,
        event: "insert",
      }))
    );
  }

  #handleData(lsn: string, message: PgoutputMessage, parseDuration: bigint) {
    this.logger.debug("Handling data", {
      lsn,
      tag: message.tag,
      parseDuration,
    });

    this.events.emit("message", { lsn, message, service: this });

    switch (message.tag) {
      case "begin": {
        if (this._isShuttingDown || this._isShutDownComplete) {
          return;
        }

        this._currentTransaction = {
          beginStartTimestamp: Date.now(),
          commitLsn: message.commitLsn,
          xid: message.xid,
          events: [],
        };

        this._currentParseDurationMs = Number(parseDuration) / 1_000_000;

        break;
      }
      case "insert": {
        if (!this._currentTransaction) {
          return;
        }

        if (this._currentParseDurationMs) {
          this._currentParseDurationMs =
            this._currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        this._currentTransaction.events.push({
          tag: message.tag,
          data: message.new as TaskRun,
          raw: message,
        });
        break;
      }
      case "update": {
        if (!this._currentTransaction) {
          return;
        }

        if (this._currentParseDurationMs) {
          this._currentParseDurationMs =
            this._currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        this._currentTransaction.events.push({
          tag: message.tag,
          data: message.new as TaskRun,
          raw: message,
        });
        break;
      }
      case "delete": {
        if (!this._currentTransaction) {
          return;
        }

        if (this._currentParseDurationMs) {
          this._currentParseDurationMs =
            this._currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        this._currentTransaction.events.push({
          tag: message.tag,
          data: message.old as TaskRun,
          raw: message,
        });

        break;
      }
      case "commit": {
        if (!this._currentTransaction) {
          return;
        }

        if (this._currentParseDurationMs) {
          this._currentParseDurationMs =
            this._currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        const replicationLagMs = Date.now() - Number(message.commitTime / 1000n);
        this._currentTransaction.commitEndLsn = message.commitEndLsn;
        this._currentTransaction.replicationLagMs = replicationLagMs;
        const transaction = this._currentTransaction as Transaction<PostgresTaskRun>;
        this._currentTransaction = null;

        if (transaction.commitEndLsn) {
          this._latestCommitEndLsn = transaction.commitEndLsn;
        }

        this.#handleTransaction(transaction);
        break;
      }
      default: {
        this.logger.debug("Unknown message tag", {
          pgMessage: message,
        });
      }
    }
  }

  #handleTransaction(transaction: Transaction<PostgresTaskRun>) {
    if (this._isShutDownComplete) return;

    if (this._isShuttingDown) {
      this._replicationClient.stop().finally(() => {
        this._isShutDownComplete = true;
      });
    }

    // If there are no events, do nothing
    if (transaction.events.length === 0) {
      return;
    }

    if (!transaction.commitEndLsn) {
      this.logger.error("Transaction has no commit end lsn", {
        transaction,
      });

      return;
    }

    const lsnToUInt64Start = process.hrtime.bigint();

    // If there are events, we need to handle them
    const _version = lsnToUInt64(transaction.commitEndLsn);

    const lsnToUInt64DurationMs = Number(process.hrtime.bigint() - lsnToUInt64Start) / 1_000_000;

    this._concurrentFlushScheduler.addToBatch(
      transaction.events.map((event) => ({
        _version,
        run: event.data,
        event: event.tag,
      }))
    );

    // Record metrics
    this._replicationLagHistogram.record(transaction.replicationLagMs);

    // Count events by type
    for (const event of transaction.events) {
      this._eventsProcessedCounter.add(1, { event_type: event.tag });
    }

    this.logger.debug("handle_transaction", {
      transaction: {
        xid: transaction.xid,
        commitLsn: transaction.commitLsn,
        commitEndLsn: transaction.commitEndLsn,
        events: transaction.events.length,
        parseDurationMs: this._currentParseDurationMs,
        lsnToUInt64DurationMs,
        version: _version.toString(),
      },
    });
  }

  async #acknowledgeLatestTransaction() {
    if (!this._latestCommitEndLsn) {
      return;
    }

    if (this._lastAcknowledgedLsn === this._latestCommitEndLsn) {
      return;
    }

    const now = Date.now();

    if (this._lastAcknowledgedAt) {
      const timeSinceLastAcknowledged = now - this._lastAcknowledgedAt;
      // If we've already acknowledged within the last second, don't acknowledge again
      if (timeSinceLastAcknowledged < this._acknowledgeTimeoutMs) {
        return;
      }
    }

    this._lastAcknowledgedAt = now;
    this._lastAcknowledgedLsn = this._latestCommitEndLsn;

    this.logger.info("acknowledge_latest_transaction", {
      commitEndLsn: this._latestCommitEndLsn,
      lastAcknowledgedAt: this._lastAcknowledgedAt,
    });

    const [ackError] = await tryCatch(
      this._replicationClient.acknowledge(this._latestCommitEndLsn)
    );

    if (ackError) {
      this.logger.error("Error acknowledging transaction", { ackError });
    }

    if (this._isShutDownComplete && this._acknowledgeInterval) {
      clearInterval(this._acknowledgeInterval);
    }
  }

  async #flushBatch(flushId: string, batch: Array<TaskRunInsert>) {
    if (batch.length === 0) {
      return;
    }

    this.logger.debug("Flushing batch", {
      flushId,
      batchSize: batch.length,
    });

    const flushStartTime = performance.now();

    await startSpan(this._tracer, "flushBatch", async (span) => {
      const preparedInserts = await startSpan(this._tracer, "prepare_inserts", async (span) => {
        return await Promise.all(batch.map(this.#prepareRunInserts.bind(this)));
      });

      const taskRunInserts = preparedInserts
        .map(({ taskRunInsert }) => taskRunInsert)
        .filter((x): x is TaskRunInsertArray => Boolean(x))
        // batch inserts in clickhouse are more performant if the items
        // are pre-sorted by the primary key
        .sort((a, b) => {
          const aOrgId = getTaskRunField(a, "organization_id");
          const bOrgId = getTaskRunField(b, "organization_id");
          if (aOrgId !== bOrgId) {
            return aOrgId < bOrgId ? -1 : 1;
          }
          const aProjId = getTaskRunField(a, "project_id");
          const bProjId = getTaskRunField(b, "project_id");
          if (aProjId !== bProjId) {
            return aProjId < bProjId ? -1 : 1;
          }
          const aEnvId = getTaskRunField(a, "environment_id");
          const bEnvId = getTaskRunField(b, "environment_id");
          if (aEnvId !== bEnvId) {
            return aEnvId < bEnvId ? -1 : 1;
          }
          const aCreatedAt = getTaskRunField(a, "created_at");
          const bCreatedAt = getTaskRunField(b, "created_at");
          if (aCreatedAt !== bCreatedAt) {
            return aCreatedAt - bCreatedAt;
          }
          const aRunId = getTaskRunField(a, "run_id");
          const bRunId = getTaskRunField(b, "run_id");
          if (aRunId === bRunId) return 0;
          return aRunId < bRunId ? -1 : 1;
        });

      const payloadInserts = preparedInserts
        .map(({ payloadInsert }) => payloadInsert)
        .filter((x): x is PayloadInsertArray => Boolean(x))
        // batch inserts in clickhouse are more performant if the items
        // are pre-sorted by the primary key
        .sort((a, b) => {
          const aRunId = getPayloadField(a, "run_id");
          const bRunId = getPayloadField(b, "run_id");
          if (aRunId === bRunId) return 0;
          return aRunId < bRunId ? -1 : 1;
        });

      span.setAttribute("task_run_inserts", taskRunInserts.length);
      span.setAttribute("payload_inserts", payloadInserts.length);

      this.logger.debug("Flushing inserts", {
        flushId,
        taskRunInserts: taskRunInserts.length,
        payloadInserts: payloadInserts.length,
      });

      // Insert task runs and payloads with retry logic for connection errors
      const [taskRunError, taskRunResult] = await this.#insertWithRetry(
        (attempt) => this.#insertTaskRunInserts(taskRunInserts, attempt),
        "task run inserts",
        flushId
      );

      const [payloadError, payloadResult] = await this.#insertWithRetry(
        (attempt) => this.#insertPayloadInserts(payloadInserts, attempt),
        "payload inserts",
        flushId
      );

      // Log any errors that occurred
      if (taskRunError) {
        this.logger.error("Error inserting task run inserts", {
          error: taskRunError,
          flushId,
        });
        recordSpanError(span, taskRunError);
      }

      if (payloadError) {
        this.logger.error("Error inserting payload inserts", {
          error: payloadError,
          flushId,
        });
        recordSpanError(span, payloadError);
      }

      this.logger.debug("Flushed inserts", {
        flushId,
        taskRunInserts: taskRunInserts.length,
        payloadInserts: payloadInserts.length,
      });

      this.events.emit("batchFlushed", { flushId, taskRunInserts, payloadInserts });

      // Record metrics
      const flushDurationMs = performance.now() - flushStartTime;
      const hasErrors = taskRunError !== null || payloadError !== null;

      this._batchSizeHistogram.record(batch.length);
      this._flushDurationHistogram.record(flushDurationMs);
      this._batchesFlushedCounter.add(1, { success: !hasErrors });

      if (!taskRunError) {
        this._taskRunsInsertedCounter.add(taskRunInserts.length);
      }

      if (!payloadError) {
        this._payloadsInsertedCounter.add(payloadInserts.length);
      }
    });
  }

  // New method to handle inserts with retry logic for connection errors
  async #insertWithRetry<T>(
    insertFn: (attempt: number) => Promise<T>,
    operationName: string,
    flushId: string
  ): Promise<[Error | null, T | null]> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this._insertMaxRetries; attempt++) {
      try {
        const result = await insertFn(attempt);
        return [null, result];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this is a retryable error
        if (this.#isRetryableError(lastError)) {
          const delay = this.#calculateRetryDelay(attempt);

          this.logger.warn(`Retrying RunReplication insert due to error`, {
            operationName,
            flushId,
            attempt,
            maxRetries: this._insertMaxRetries,
            error: lastError.message,
            delay,
          });

          // Record retry metric
          const operation = operationName.includes("task run") ? "task_runs" : "payloads";
          this._insertRetriesCounter.add(1, { operation });

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        break;
      }
    }

    return [lastError, null];
  }

  // Retry all errors except known permanent ones
  #isRetryableError(error: Error): boolean {
    const errorMessage = error.message.toLowerCase();

    // Permanent errors that should NOT be retried
    const permanentErrorPatterns = [
      "authentication failed",
      "permission denied",
      "invalid credentials",
      "table not found",
      "database not found",
      "column not found",
      "schema mismatch",
      "invalid query",
      "syntax error",
      "type error",
      "constraint violation",
      "duplicate key",
      "foreign key violation",
    ];

    // If it's a known permanent error, don't retry
    if (permanentErrorPatterns.some((pattern) => errorMessage.includes(pattern))) {
      return false;
    }

    // Retry everything else
    return true;
  }

  #calculateRetryDelay(attempt: number): number {
    // Exponential backoff: baseDelay, baseDelay*2, baseDelay*4, etc.
    const delay = Math.min(
      this._insertBaseDelayMs * Math.pow(2, attempt - 1),
      this._insertMaxDelayMs
    );

    // Add some jitter to prevent thundering herd
    const jitter = Math.random() * 100;
    return delay + jitter;
  }

  #getClickhouseInsertSettings() {
    if (this._insertStrategy === "insert") {
      return {};
    }

    return {
      async_insert: 1 as const,
      async_insert_max_data_size: "1000000",
      async_insert_busy_timeout_ms: 1000,
      wait_for_async_insert: this.options.waitForAsyncInsert ? (1 as const) : (0 as const),
    };
  }

  async #insertTaskRunInserts(taskRunInserts: TaskRunInsertArray[], attempt: number) {
    return await startSpan(this._tracer, "insertTaskRunsInserts", async (span) => {
      const [insertError, insertResult] =
        await this.options.clickhouse.taskRuns.insertCompactArrays(taskRunInserts, {
          params: {
            clickhouse_settings: this.#getClickhouseInsertSettings(),
          },
        });

      if (insertError) {
        this.logger.error("Error inserting task run inserts attempt", {
          error: insertError,
          attempt,
        });

        recordSpanError(span, insertError);
        throw insertError;
      }

      return insertResult;
    });
  }

  async #insertPayloadInserts(payloadInserts: PayloadInsertArray[], attempt: number) {
    return await startSpan(this._tracer, "insertPayloadInserts", async (span) => {
      const [insertError, insertResult] =
        await this.options.clickhouse.taskRuns.insertPayloadsCompactArrays(payloadInserts, {
          params: {
            clickhouse_settings: this.#getClickhouseInsertSettings(),
          },
        });

      if (insertError) {
        this.logger.error("Error inserting payload inserts attempt", {
          error: insertError,
          attempt,
        });

        recordSpanError(span, insertError);
        throw insertError;
      }

      return insertResult;
    });
  }

  async #prepareRunInserts(
    batchedRun: TaskRunInsert
  ): Promise<{ taskRunInsert?: TaskRunInsertArray; payloadInsert?: PayloadInsertArray }> {
    this.logger.debug("Preparing run", {
      batchedRun,
    });

    const { run, _version, event } = batchedRun;

    if (!run.environmentType || !run.organizationId) {
      return {};
    }

    if (event === "update" || event === "delete" || this._disablePayloadInsert) {
      const taskRunInsert = await this.#prepareTaskRunInsert(
        run,
        run.organizationId,
        run.environmentType,
        event,
        _version
      );

      return { taskRunInsert };
    }

    const [taskRunInsert, payloadInsert] = await Promise.all([
      this.#prepareTaskRunInsert(run, run.organizationId, run.environmentType, event, _version),
      this.#preparePayloadInsert(run, _version),
    ]);

    return { taskRunInsert, payloadInsert };
  }

  async #prepareTaskRunInsert(
    run: PostgresTaskRun,
    organizationId: string,
    environmentType: string,
    event: "insert" | "update" | "delete",
    _version: bigint
  ): Promise<TaskRunInsertArray> {
    const output = await this.#prepareJson(run.output, run.outputType);

    // Return array matching TASK_RUN_COLUMNS order
    return [
      run.runtimeEnvironmentId, // environment_id
      organizationId, // organization_id
      run.projectId, // project_id
      run.id, // run_id
      run.updatedAt.getTime(), // updated_at
      run.createdAt.getTime(), // created_at
      run.status, // status
      environmentType, // environment_type
      run.friendlyId, // friendly_id
      run.attemptNumber ?? 1, // attempt
      run.engine, // engine
      run.taskIdentifier, // task_identifier
      run.queue, // queue
      run.scheduleId ?? "", // schedule_id
      run.batchId ?? "", // batch_id
      run.completedAt?.getTime() ?? null, // completed_at
      run.startedAt?.getTime() ?? null, // started_at
      run.executedAt?.getTime() ?? null, // executed_at
      run.delayUntil?.getTime() ?? null, // delay_until
      run.queuedAt?.getTime() ?? null, // queued_at
      run.expiredAt?.getTime() ?? null, // expired_at
      run.usageDurationMs ?? 0, // usage_duration_ms
      run.costInCents ?? 0, // cost_in_cents
      run.baseCostInCents ?? 0, // base_cost_in_cents
      output, // output
      { data: run.error }, // error
      run.runTags ?? [], // tags
      run.taskVersion ?? "", // task_version
      run.sdkVersion ?? "", // sdk_version
      run.cliVersion ?? "", // cli_version
      run.machinePreset ?? "", // machine_preset
      run.rootTaskRunId ?? "", // root_run_id
      run.parentTaskRunId ?? "", // parent_run_id
      run.depth ?? 0, // depth
      run.spanId, // span_id
      run.traceId, // trace_id
      run.idempotencyKey ?? "", // idempotency_key
      unsafeExtractIdempotencyKeyUser(run) ?? "", // idempotency_key_user
      unsafeExtractIdempotencyKeyScope(run) ?? "", // idempotency_key_scope
      run.ttl ?? "", // expiration_ttl
      run.isTest ?? false, // is_test
      _version.toString(), // _version
      event === "delete" ? 1 : 0, // _is_deleted
      run.concurrencyKey ?? "", // concurrency_key
      run.bulkActionGroupIds ?? [], // bulk_action_group_ids
      run.masterQueue ?? "", // worker_queue
      run.maxDurationInSeconds ?? null, // max_duration_in_seconds
    ];
  }

  async #preparePayloadInsert(run: TaskRun, _version: bigint): Promise<PayloadInsertArray> {
    const payload = await this.#prepareJson(run.payload, run.payloadType);

    // Return array matching PAYLOAD_COLUMNS order
    return [
      run.id, // run_id
      run.createdAt.getTime(), // created_at
      payload, // payload
    ];
  }

  async #prepareJson(
    data: string | undefined | null,
    dataType: string
  ): Promise<{ data: unknown }> {
    if (!data) {
      return { data: undefined };
    }

    if (dataType !== "application/json" && dataType !== "application/super+json") {
      return { data: undefined };
    }

    if (detectBadJsonStrings(data)) {
      this.logger.warn("Detected bad JSON strings", {
        data,
        dataType,
      });
      return { data: undefined };
    }

    const packet = {
      data,
      dataType,
    };

    const [parseError, parsedData] = await tryCatch(parsePacketAsJson(packet));

    if (parseError) {
      this.logger.error("Error parsing packet", {
        error: parseError,
        packet,
      });

      return { data: undefined };
    }

    return { data: parsedData };
  }

}

export type ConcurrentFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  maxConcurrency?: number;
  callback: (flushId: string, batch: T[]) => Promise<void>;
  /** Key-based deduplication. Return null to skip the item. */
  getKey: (item: T) => string | null;
  /** Determine if incoming item should replace existing. */
  shouldReplace: (existing: T, incoming: T) => boolean;
  tracer?: Tracer;
  logger?: Logger;
};

export class ConcurrentFlushScheduler<T> {
  private batch = new Map<string, T>();
  private readonly BATCH_SIZE: number;
  private readonly flushInterval: number;
  private readonly MAX_CONCURRENCY: number;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;
  private flushTimer: NodeJS.Timeout | null;
  private failedBatchCount;
  private logger: Logger;
  private _tracer: Tracer;
  private _isShutDown = false;

  constructor(private readonly config: ConcurrentFlushSchedulerConfig<T>) {
    this.logger = config.logger ?? new Logger("ConcurrentFlushScheduler", "info");
    this._tracer = config.tracer ?? trace.getTracer("concurrent-flush-scheduler");

    this.BATCH_SIZE = config.batchSize;
    this.flushInterval = config.flushInterval;
    this.MAX_CONCURRENCY = config.maxConcurrency || 1;
    this.concurrencyLimiter = pLimit(this.MAX_CONCURRENCY);
    this.flushTimer = null;
    this.failedBatchCount = 0;
  }

  addToBatch(items: T[]): void {
    for (const item of items) {
      const key = this.config.getKey(item);
      if (key === null) {
        continue;
      }

      const existing = this.batch.get(key);
      if (!existing || this.config.shouldReplace(existing, item)) {
        this.batch.set(key, item);
      }
    }

    this.#flushNextBatchIfNeeded();
  }

  start(): void {
    this.logger.info("Starting ConcurrentFlushScheduler", {
      batchSize: this.BATCH_SIZE,
      flushInterval: this.flushInterval,
      maxConcurrency: this.MAX_CONCURRENCY,
    });

    this.#startFlushTimer();
  }

  shutdown(): void {
    this.logger.info("Shutting down ConcurrentFlushScheduler");

    this._isShutDown = true;

    this.#clearTimer();
    this.#flushNextBatchIfNeeded();
  }

  #getBatchSize(): number {
    return this.batch.size;
  }

  #flushNextBatchIfNeeded(): void {
    const currentSize = this.#getBatchSize();
    if (currentSize >= this.BATCH_SIZE || this._isShutDown) {
      this.logger.debug("Batch size threshold reached, initiating flush", {
        batchSize: this.BATCH_SIZE,
        currentSize,
        isShutDown: this._isShutDown,
      });

      this.#flushNextBatch().catch((error) => {
        this.logger.error("Error flushing next batch", {
          error,
        });
      });
    }
  }

  #startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.#checkAndFlush().catch(() => {}), this.flushInterval);
    this.logger.debug("Started flush timer", { interval: this.flushInterval });
  }

  #clearTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.logger.debug("Flush timer cleared");
    }
  }

  async #checkAndFlush(): Promise<void> {
    const currentSize = this.#getBatchSize();
    if (currentSize > 0) {
      this.logger.debug("Periodic flush check triggered", {
        currentBatchSize: currentSize,
      });
      await this.#flushNextBatch();
    }
  }

  async #flushNextBatch(): Promise<void> {
    if (this.batch.size === 0) return;

    const batch = Array.from(this.batch.values());
    this.batch.clear();

    const callback = this.config.callback;

    const promise = this.concurrencyLimiter(async () => {
      return await startSpan(this._tracer, "flushNextBatch", async (span) => {
        const batchId = nanoid();

        span.setAttribute("batch_id", batchId);
        span.setAttribute("batch_size", batch.length);
        span.setAttribute("concurrency_active_count", this.concurrencyLimiter.activeCount);
        span.setAttribute("concurrency_pending_count", this.concurrencyLimiter.pendingCount);
        span.setAttribute("concurrency_concurrency", this.concurrencyLimiter.concurrency);

        this.logger.info("flush_next_batch", {
          batchId,
          batchSize: batch.length,
          concurrencyActiveCount: this.concurrencyLimiter.activeCount,
          concurrencyPendingCount: this.concurrencyLimiter.pendingCount,
          concurrencyConcurrency: this.concurrencyLimiter.concurrency,
        });

        const start = performance.now();

        await callback(batchId, batch);

        const end = performance.now();

        const duration = end - start;

        return {
          batchId,
          duration,
        };
      });
    });

    const [error, result] = await tryCatch(promise);

    if (error) {
      this.logger.error("flush_batch_error", {
        error,
      });

      this.failedBatchCount++;
    } else {
      this.logger.info("flush_batch_complete", {
        totalBatches: 1,
        successfulBatches: 1,
        failedBatches: 0,
        totalFailedBatches: this.failedBatchCount,
        duration: result?.duration,
        batchId: result?.batchId,
      });
    }
  }
}

function lsnToUInt64(lsn: string): bigint {
  const [seg, off] = lsn.split("/");
  return (BigInt("0x" + seg) << 32n) | BigInt("0x" + off);
}
