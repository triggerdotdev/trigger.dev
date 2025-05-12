import type { ClickHouse, RawTaskRunPayloadV1, TaskRunV1 } from "@internal/clickhouse";
import { RedisOptions } from "@internal/redis";
import {
  LogicalReplicationClient,
  type MessageDelete,
  type MessageInsert,
  type MessageUpdate,
  type PgoutputMessage,
} from "@internal/replication";
import { startSpan, trace, type Tracer } from "@internal/tracing";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { tryCatch } from "@trigger.dev/core/utils";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { TaskRun } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import EventEmitter from "node:events";
import pLimit from "p-limit";

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
  ackIntervalSeconds?: number;
  acknowledgeTimeoutMs?: number;
  logger?: Logger;
  logLevel?: LogLevel;
  tracer?: Tracer;
};

type TaskRunInsert = { _version: bigint; run: TaskRun; event: "insert" | "update" | "delete" };

export type RunsReplicationServiceEvents = {
  message: [{ lsn: string; message: PgoutputMessage; service: RunsReplicationService }];
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
  private _currentParseDurationMs: number | null = null;
  private _lastAcknowledgedAt: number | null = null;
  private _acknowledgeTimeoutMs: number;
  private _latestCommitEndLsn: string | null = null;
  private _lastAcknowledgedLsn: string | null = null;
  private _acknowledgeInterval: NodeJS.Timeout | null = null;

  public readonly events: EventEmitter<RunsReplicationServiceEvents>;

  constructor(private readonly options: RunsReplicationServiceOptions) {
    this.logger =
      options.logger ?? new Logger("RunsReplicationService", options.logLevel ?? "info");
    this.events = new EventEmitter();
    this._tracer = options.tracer ?? trace.getTracer("runs-replication-service");

    this._acknowledgeTimeoutMs = options.acknowledgeTimeoutMs ?? 1_000;

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
      logger: new Logger("LogicalReplicationClient", options.logLevel ?? "info"),
      leaderLockTimeoutMs: options.leaderLockTimeoutMs ?? 30_000,
      leaderLockExtendIntervalMs: options.leaderLockExtendIntervalMs ?? 10_000,
      ackIntervalSeconds: options.ackIntervalSeconds ?? 10,
    });

    this._concurrentFlushScheduler = new ConcurrentFlushScheduler<TaskRunInsert>({
      batchSize: options.flushBatchSize ?? 50,
      flushInterval: options.flushIntervalMs ?? 100,
      maxConcurrency: options.maxFlushConcurrency ?? 100,
      callback: this.#flushBatch.bind(this),
      logger: new Logger("ConcurrentFlushScheduler", options.logLevel ?? "info"),
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
      this.logger.debug("Replication client started");
    });

    this._replicationClient.events.on("acknowledge", ({ lsn }) => {
      this.logger.debug("Acknowledged", { lsn });
    });

    this._replicationClient.events.on("leaderElection", (isLeader) => {
      this.logger.debug("Leader election", { isLeader });
    });
  }

  public async shutdown() {
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
        const transaction = this._currentTransaction as Transaction<TaskRun>;
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

  #handleTransaction(transaction: Transaction<TaskRun>) {
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

    this.logger.debug("Handling transaction", {
      transaction,
    });

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

    const currentSpan = this._tracer.startSpan("handle_transaction", {
      attributes: {
        "transaction.xid": transaction.xid,
        "transaction.replication_lag_ms": transaction.replicationLagMs,
        "transaction.events": transaction.events.length,
        "transaction.commit_end_lsn": transaction.commitEndLsn,
        "transaction.parse_duration_ms": this._currentParseDurationMs ?? undefined,
        "transaction.lsn_to_uint64_ms": lsnToUInt64DurationMs,
        "transaction.version": _version.toString(),
      },
      startTime: transaction.beginStartTimestamp,
    });

    currentSpan.end();
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

    this.logger.debug("Acknowledging transaction", {
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
      this.logger.debug("No runs to flush", {
        flushId,
      });
      return;
    }

    this.logger.debug("Flushing batch", {
      flushId,
      batchSize: batch.length,
    });

    await startSpan(this._tracer, "flushBatch", async (span) => {
      const preparedInserts = await startSpan(this._tracer, "prepare_inserts", async (span) => {
        return await Promise.all(batch.map(this.#prepareRunInserts.bind(this)));
      });

      const taskRunInserts = preparedInserts
        .map(({ taskRunInsert }) => taskRunInsert)
        .filter(Boolean);

      const payloadInserts = preparedInserts
        .map(({ payloadInsert }) => payloadInsert)
        .filter(Boolean);

      span.setAttribute("task_run_inserts", taskRunInserts.length);
      span.setAttribute("payload_inserts", payloadInserts.length);

      this.logger.debug("Flushing inserts", {
        flushId,
        taskRunInserts: taskRunInserts.length,
        payloadInserts: payloadInserts.length,
      });

      await Promise.all([
        this.#insertTaskRunInserts(taskRunInserts),
        this.#insertPayloadInserts(payloadInserts),
      ]);

      this.logger.debug("Flushed inserts", {
        flushId,
        taskRunInserts: taskRunInserts.length,
        payloadInserts: payloadInserts.length,
      });
    });
  }

  async #insertTaskRunInserts(taskRunInserts: TaskRunV1[]) {
    const [insertError, insertResult] = await this.options.clickhouse.taskRuns.insert(
      taskRunInserts,
      {
        params: {
          clickhouse_settings: {
            wait_for_async_insert: 1,
          },
        },
      }
    );

    if (insertError) {
      this.logger.error("Error inserting task run inserts", {
        error: insertError,
      });
    }

    return insertResult;
  }

  async #insertPayloadInserts(payloadInserts: RawTaskRunPayloadV1[]) {
    const [insertError, insertResult] = await this.options.clickhouse.taskRuns.insertPayloads(
      payloadInserts,
      {
        params: {
          clickhouse_settings: {
            wait_for_async_insert: 1,
          },
        },
      }
    );

    if (insertError) {
      this.logger.error("Error inserting payload inserts", {
        error: insertError,
      });
    }

    return insertResult;
  }

  async #prepareRunInserts(
    batchedRun: TaskRunInsert
  ): Promise<{ taskRunInsert?: TaskRunV1; payloadInsert?: RawTaskRunPayloadV1 }> {
    this.logger.debug("Preparing run", {
      batchedRun,
    });

    const { run, _version, event } = batchedRun;

    if (!run.environmentType) {
      return {
        taskRunInsert: undefined,
        payloadInsert: undefined,
      };
    }

    if (!run.organizationId) {
      return {
        taskRunInsert: undefined,
        payloadInsert: undefined,
      };
    }

    if (event === "update" || event === "delete") {
      const taskRunInsert = await this.#prepareTaskRunInsert(
        run,
        run.organizationId,
        run.environmentType,
        event,
        _version
      );

      return {
        taskRunInsert,
        payloadInsert: undefined,
      };
    }

    const [taskRunInsert, payloadInsert] = await Promise.all([
      this.#prepareTaskRunInsert(run, run.organizationId, run.environmentType, event, _version),
      this.#preparePayloadInsert(run, _version),
    ]);

    return {
      taskRunInsert,
      payloadInsert,
    };
  }

  async #prepareTaskRunInsert(
    run: TaskRun,
    organizationId: string,
    environmentType: string,
    event: "insert" | "update" | "delete",
    _version: bigint
  ): Promise<TaskRunV1> {
    const output = await this.#prepareJson(run.output, run.outputType);

    return {
      environment_id: run.runtimeEnvironmentId,
      organization_id: organizationId,
      project_id: run.projectId,
      run_id: run.id,
      updated_at: run.updatedAt.getTime(),
      created_at: run.createdAt.getTime(),
      status: run.status,
      environment_type: environmentType,
      friendly_id: run.friendlyId,
      engine: run.engine,
      task_identifier: run.taskIdentifier,
      queue: run.queue,
      span_id: run.spanId,
      trace_id: run.traceId,
      error: { data: run.error },
      attempt: run.attemptNumber ?? 1,
      schedule_id: run.scheduleId ?? "",
      batch_id: run.batchId ?? "",
      completed_at: run.completedAt?.getTime(),
      started_at: run.startedAt?.getTime(),
      executed_at: run.executedAt?.getTime(),
      delay_until: run.delayUntil?.getTime(),
      queued_at: run.queuedAt?.getTime(),
      expired_at: run.expiredAt?.getTime(),
      usage_duration_ms: run.usageDurationMs,
      cost_in_cents: run.costInCents,
      base_cost_in_cents: run.baseCostInCents,
      tags: run.runTags ?? [],
      task_version: run.taskVersion ?? "",
      sdk_version: run.sdkVersion ?? "",
      cli_version: run.cliVersion ?? "",
      machine_preset: run.machinePreset ?? "",
      root_run_id: run.rootTaskRunId ?? "",
      parent_run_id: run.parentTaskRunId ?? "",
      depth: run.depth,
      is_test: run.isTest,
      idempotency_key: run.idempotencyKey ?? "",
      expiration_ttl: run.ttl ?? "",
      output,
      _version: _version.toString(),
      _is_deleted: event === "delete" ? 1 : 0,
    };
  }

  async #preparePayloadInsert(run: TaskRun, _version: bigint): Promise<RawTaskRunPayloadV1> {
    const payload = await this.#prepareJson(run.payload, run.payloadType);

    return {
      run_id: run.id,
      created_at: run.createdAt.getTime(),
      payload,
    };
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

    const packet = {
      data,
      dataType,
    };

    const [parseError, parsedData] = await tryCatch(parsePacket(packet));

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
  tracer?: Tracer;
  logger?: Logger;
};

export class ConcurrentFlushScheduler<T> {
  private currentBatch: T[]; // Adjust the type according to your data structure
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

    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.flushInterval = config.flushInterval;
    this.MAX_CONCURRENCY = config.maxConcurrency || 1;
    this.concurrencyLimiter = pLimit(this.MAX_CONCURRENCY);
    this.flushTimer = null;
    this.failedBatchCount = 0;
  }

  addToBatch(items: T[]): void {
    this.currentBatch = this.currentBatch.concat(items);
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

  #flushNextBatchIfNeeded(): void {
    if (this.currentBatch.length >= this.BATCH_SIZE || this._isShutDown) {
      this.logger.debug("Batch size threshold reached, initiating flush", {
        batchSize: this.BATCH_SIZE,
        currentSize: this.currentBatch.length,
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
    if (this.currentBatch.length > 0) {
      this.logger.debug("Periodic flush check triggered", {
        currentBatchSize: this.currentBatch.length,
      });
      await this.#flushNextBatch();
    }
  }

  async #flushNextBatch(): Promise<void> {
    if (this.currentBatch.length === 0) return;

    const batch = this.currentBatch;
    this.currentBatch = [];

    const callback = this.config.callback;

    const promise = this.concurrencyLimiter(async () => {
      await startSpan(this._tracer, "flushNextBatch", async (span) => {
        const batchId = nanoid();

        span.setAttribute("batch_id", batchId);
        span.setAttribute("batch_size", batch.length);
        span.setAttribute("concurrency_active_count", this.concurrencyLimiter.activeCount);
        span.setAttribute("concurrency_pending_count", this.concurrencyLimiter.pendingCount);
        span.setAttribute("concurrency_concurrency", this.concurrencyLimiter.concurrency);

        await callback(batchId, batch);
      });
    });

    const [error] = await tryCatch(promise);

    if (error) {
      this.logger.error("Error flushing batch", {
        error,
      });

      this.failedBatchCount++;
    }

    this.logger.debug("Batch flush complete", {
      totalBatches: 1,
      successfulBatches: 1,
      failedBatches: 0,
      totalFailedBatches: this.failedBatchCount,
    });
  }
}

function lsnToUInt64(lsn: string): bigint {
  const [seg, off] = lsn.split("/");
  return (BigInt("0x" + seg) << 32n) | BigInt("0x" + off);
}
