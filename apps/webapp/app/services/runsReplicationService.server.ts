import type { ClickHouse, TaskRunV1 } from "@internal/clickhouse";
import { RedisOptions } from "@internal/redis";
import { LogicalReplicationClient, Transaction, type PgoutputMessage } from "@internal/replication";
import { Logger } from "@trigger.dev/core/logger";
import { tryCatch } from "@trigger.dev/core/utils";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { parsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { TaskRun } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import pLimit from "p-limit";
import { Counter, Gauge } from "prom-client";
import type { MetricsRegister } from "~/metrics.server";

export type RunsReplicationServiceOptions = {
  clickhouse: ClickHouse;
  pgConnectionUrl: string;
  serviceName: string;
  slotName: string;
  publicationName: string;
  redisOptions: RedisOptions;
  metricsRegister?: MetricsRegister;
  insertStrategy?: "streaming" | "batching";
  maxFlushConcurrency?: number;
  flushIntervalMs?: number;
  flushBatchSize?: number;
};

export class RunsReplicationService {
  private _lastLsn: string | null = null;
  private _isSubscribed = false;
  private _currentTransaction:
    | (Omit<Transaction<TaskRun>, "commitEndLsn" | "replicationLagMs"> & {
        commitEndLsn?: string | null;
        replicationLagMs?: number;
      })
    | null = null;

  private _replicationClient: LogicalReplicationClient;
  private _concurrentFlushScheduler: ConcurrentFlushScheduler<{ _version: bigint; run: TaskRun }>;
  private logger: Logger;
  private _lastReplicationLagMs: number | null = null;
  private _transactionCounter?: Counter;
  private _insertStrategy: "streaming" | "batching";

  constructor(private readonly options: RunsReplicationServiceOptions) {
    this.logger = new Logger("RunsReplicationService", "debug");

    this._insertStrategy = options.insertStrategy ?? "streaming";

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
      publicationActions: ["insert", "update"],
      logger: new Logger("RunsReplicationService", "debug"),
      leaderLockTimeoutMs: 30_000,
      leaderLockExtendIntervalMs: 10_000,
      ackIntervalSeconds: 10,
    });

    this._concurrentFlushScheduler = new ConcurrentFlushScheduler<{
      _version: bigint;
      run: TaskRun;
    }>({
      batchSize: options.flushBatchSize ?? 50,
      flushInterval: options.flushIntervalMs ?? 100,
      maxConcurrency: options.maxFlushConcurrency ?? 100,
      callback: this.#flushBatch.bind(this),
      metricsRegister: options.metricsRegister,
    });

    this._replicationClient.events.on("data", async ({ lsn, log }) => {
      this._lastLsn = lsn;

      await this.#handleData(lsn, log);
    });

    this._replicationClient.events.on("heartbeat", async ({ lsn, shouldRespond }) => {
      if (shouldRespond) {
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

    if (options.metricsRegister) {
      const replicationService = this;
      new Gauge({
        name: "runs_replication_service_replication_lag_ms",
        help: "The replication lag in milliseconds",
        collect() {
          if (!replicationService._lastReplicationLagMs) {
            return;
          }

          this.set(replicationService._lastReplicationLagMs);
        },
        registers: [options.metricsRegister],
      });

      replicationService._transactionCounter = new Counter({
        name: "runs_replication_service_transactions",
        help: "The number of transactions",
        registers: [options.metricsRegister],
      });
    }
  }

  async start() {
    this.logger.info("Starting replication client", {
      lastLsn: this._lastLsn,
    });

    await this._replicationClient.subscribe(this._lastLsn ?? undefined);
  }

  async stop() {
    this.logger.info("Stopping replication client");

    await this._replicationClient.stop();
  }

  async teardown() {
    this.logger.info("Teardown replication client");

    await this._replicationClient.teardown();
  }

  async #handleData(lsn: string, message: PgoutputMessage) {
    switch (message.tag) {
      case "begin": {
        this._currentTransaction = {
          commitLsn: message.commitLsn,
          xid: message.xid,
          events: [],
        };
        break;
      }
      case "insert": {
        if (!this._currentTransaction) {
          return;
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

        this._currentTransaction.events.push({
          tag: message.tag,
          data: message.new as TaskRun,
          raw: message,
        });
        break;
      }
      case "commit": {
        if (!this._currentTransaction) {
          return;
        }
        const replicationLagMs = Date.now() - Number(message.commitTime / 1000n);
        this._currentTransaction.commitEndLsn = message.commitEndLsn;
        this._currentTransaction.replicationLagMs = replicationLagMs;
        await this.#handleTransaction(this._currentTransaction as Transaction<TaskRun>);
        this._currentTransaction = null;
        break;
      }
    }
  }

  async #handleTransaction(transaction: Transaction<TaskRun>) {
    this._lastReplicationLagMs = transaction.replicationLagMs;

    // If there are no events, do nothing
    if (transaction.events.length === 0) {
      if (transaction.commitEndLsn) {
        await this._replicationClient.acknowledge(transaction.commitEndLsn);
      }

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

    // If there are events, we need to handle them
    const _version = lsnToUInt64(transaction.commitEndLsn);

    this._transactionCounter?.inc();

    if (this._insertStrategy === "streaming") {
      await this._concurrentFlushScheduler.addToBatch(
        transaction.events.map((event) => ({ _version, run: event.data }))
      );
    } else {
      const [flushError] = await tryCatch(
        this.#flushBatch(
          nanoid(),
          transaction.events.map((event) => ({ _version, run: event.data }))
        )
      );

      if (flushError) {
        this.logger.error("Error flushing batch", {
          error: flushError,
        });
      }
    }

    await this._replicationClient.acknowledge(transaction.commitEndLsn);
  }

  async #flushBatch(flushId: string, batch: Array<{ _version: bigint; run: TaskRun }>) {
    if (batch.length === 0) {
      this.logger.debug("No runs to flush", {
        flushId,
      });
      return;
    }

    this.logger.info("Flushing batch", {
      flushId,
      batchSize: batch.length,
    });

    const preparedRuns = await Promise.all(batch.map(this.#prepareRun.bind(this)));
    const runsToInsert = preparedRuns.filter(Boolean);

    if (runsToInsert.length === 0) {
      this.logger.debug("No runs to insert", {
        flushId,
        batchSize: batch.length,
      });
      return;
    }

    const [insertError, insertResult] = await this.options.clickhouse.taskRuns.insert(
      runsToInsert,
      {
        params: {
          clickhouse_settings: {
            wait_for_async_insert: this._insertStrategy === "batching" ? 1 : 0,
          },
        },
      }
    );

    if (insertError) {
      this.logger.error("Error inserting runs", {
        error: insertError,
        flushId,
        batchSize: batch.length,
      });
    } else {
      this.logger.info("Flushed batch", {
        flushId,
        insertResult,
      });
    }
  }

  async #prepareRun(batchedRun: {
    run: TaskRun;
    _version: bigint;
  }): Promise<TaskRunV1 | undefined> {
    this.logger.debug("Preparing run", {
      batchedRun,
    });

    const { run, _version } = batchedRun;

    if (!run.environmentType) {
      return undefined;
    }

    if (!run.organizationId) {
      return undefined;
    }

    const [payload, output] = await Promise.all([
      this.#prepareJson(run.payload, run.payloadType),
      this.#prepareJson(run.output, run.outputType),
    ]);

    return {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      run_id: run.id,
      updated_at: run.updatedAt.getTime(),
      created_at: run.createdAt.getTime(),
      status: run.status,
      environment_type: run.environmentType,
      friendly_id: run.friendlyId,
      engine: run.engine,
      task_identifier: run.taskIdentifier,
      queue: run.queue,
      span_id: run.spanId,
      trace_id: run.traceId,
      error: run.error ? (run.error as TaskRunError) : undefined,
      attempt: run.attemptNumber ?? 1,
      schedule_id: run.scheduleId,
      batch_id: run.batchId,
      completed_at: run.completedAt?.getTime(),
      started_at: run.startedAt?.getTime(),
      executed_at: run.executedAt?.getTime(),
      delay_until: run.delayUntil?.getTime(),
      queued_at: run.queuedAt?.getTime(),
      expired_at: run.expiredAt?.getTime(),
      usage_duration_ms: run.usageDurationMs,
      cost_in_cents: run.costInCents,
      base_cost_in_cents: run.baseCostInCents,
      tags: run.runTags,
      task_version: run.taskVersion,
      sdk_version: run.sdkVersion,
      cli_version: run.cliVersion,
      machine_preset: run.machinePreset,
      root_run_id: run.rootTaskRunId,
      parent_run_id: run.parentTaskRunId,
      depth: run.depth,
      is_test: run.isTest,
      idempotency_key: run.idempotencyKey,
      expiration_ttl: run.ttl,
      payload,
      output,
      _version: _version.toString(),
    };
  }

  async #prepareJson(
    data: string | undefined | null,
    dataType: string
  ): Promise<unknown | undefined> {
    if (!data) {
      return undefined;
    }

    if (dataType !== "application/json" && dataType !== "application/super+json") {
      return undefined;
    }

    const packet = {
      data,
      dataType,
    };

    const parsedData = await parsePacket(packet);

    if (!parsedData) {
      return undefined;
    }

    return { data: parsedData };
  }
}

export type ConcurrentFlushSchedulerConfig<T> = {
  batchSize: number;
  flushInterval: number;
  maxConcurrency?: number;
  callback: (flushId: string, batch: T[]) => Promise<void>;
  metricsRegister?: MetricsRegister;
};

export class ConcurrentFlushScheduler<T> {
  private currentBatch: T[]; // Adjust the type according to your data structure
  private readonly BATCH_SIZE: number;
  private readonly FLUSH_INTERVAL: number;
  private readonly MAX_CONCURRENCY: number;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;
  private flushTimer: NodeJS.Timeout | null;
  private isShuttingDown;
  private failedBatchCount;
  private metricsRegister?: MetricsRegister;
  private logger: Logger;

  constructor(private readonly config: ConcurrentFlushSchedulerConfig<T>) {
    this.logger = new Logger("ConcurrentFlushScheduler", "info");
    this.currentBatch = [];
    this.BATCH_SIZE = config.batchSize;
    this.FLUSH_INTERVAL = config.flushInterval;
    this.MAX_CONCURRENCY = config.maxConcurrency || 1;
    this.concurrencyLimiter = pLimit(this.MAX_CONCURRENCY);
    this.flushTimer = null;
    this.isShuttingDown = false;
    this.failedBatchCount = 0;

    this.logger.info("Initializing ConcurrentFlushScheduler", {
      batchSize: this.BATCH_SIZE,
      flushInterval: this.FLUSH_INTERVAL,
      maxConcurrency: this.MAX_CONCURRENCY,
    });

    this.startFlushTimer();
    this.setupShutdownHandlers();

    if (!process.env.VITEST && config.metricsRegister) {
      this.metricsRegister = config.metricsRegister;

      const scheduler = this;

      new Gauge({
        name: "concurrent_flush_scheduler_batch_size",
        help: "Number of items in the current concurrent flush scheduler batch",
        collect() {
          this.set(scheduler.currentBatch.length);
        },
        registers: [this.metricsRegister],
      });

      new Gauge({
        name: "concurrent_flush_scheduler_failed_batches",
        help: "Number of failed batches",
        collect() {
          this.set(scheduler.failedBatchCount);
        },
        registers: [this.metricsRegister],
      });
    }
  }

  /**
   *
   * If you want to fire and forget, don't await this method.
   */
  async addToBatch(items: T[]): Promise<void> {
    // TODO: consider using concat. spread is not performant
    this.currentBatch.push(...items);
    this.logger.debug("Adding items to batch", {
      currentBatchSize: this.currentBatch.length,
      itemsAdded: items.length,
    });

    if (this.currentBatch.length >= this.BATCH_SIZE) {
      this.logger.debug("Batch size threshold reached, initiating flush", {
        batchSize: this.BATCH_SIZE,
        currentSize: this.currentBatch.length,
      });
      await this.flushNextBatch();
      this.resetFlushTimer();
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.checkAndFlush(), this.FLUSH_INTERVAL);
    this.logger.debug("Started flush timer", { interval: this.FLUSH_INTERVAL });
  }

  private setupShutdownHandlers() {
    process.on("SIGTERM", this.shutdown.bind(this));
    process.on("SIGINT", this.shutdown.bind(this));
    this.logger.debug("Shutdown handlers configured");
  }

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.logger.info("Initiating shutdown of dynamic flush scheduler", {
      remainingItems: this.currentBatch.length,
    });

    await this.checkAndFlush();
    this.clearTimer();

    this.logger.info("Dynamic flush scheduler shutdown complete", {
      totalFailedBatches: this.failedBatchCount,
    });
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.logger.debug("Flush timer cleared");
    }
  }

  private resetFlushTimer(): void {
    this.clearTimer();
    this.startFlushTimer();
    this.logger.debug("Flush timer reset");
  }

  private async checkAndFlush(): Promise<void> {
    if (this.currentBatch.length > 0) {
      this.logger.debug("Periodic flush check triggered", {
        currentBatchSize: this.currentBatch.length,
      });
      await this.flushNextBatch();
    }
  }

  private async flushNextBatch(): Promise<void> {
    if (this.currentBatch.length === 0) return;

    const batches: T[][] = [];
    while (this.currentBatch.length > 0) {
      batches.push(this.currentBatch.splice(0, this.BATCH_SIZE));
    }

    this.logger.info("Starting batch flush", {
      numberOfBatches: batches.length,
      totalItems: batches.reduce((sum, batch) => sum + batch.length, 0),
    });

    const callback = this.config.callback;

    // TODO: report plimit.activeCount and pLimit.pendingCount and pLimit.concurrency to /metrics
    const promises = batches.map((batch) =>
      this.concurrencyLimiter(async () => {
        const batchId = nanoid();
        try {
          await callback(batchId, batch);
        } catch (error) {
          this.logger.error("Error processing batch", {
            batchId,
            error,
            batchSize: batch.length,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      })
    );

    const results = await Promise.allSettled(promises);

    const failedBatches = results.filter((result) => result.status === "rejected").length;
    this.failedBatchCount += failedBatches;

    this.logger.info("Batch flush complete", {
      totalBatches: batches.length,
      successfulBatches: batches.length - failedBatches,
      failedBatches,
      totalFailedBatches: this.failedBatchCount,
    });
  }
}

function lsnToUInt64(lsn: string): bigint {
  const [seg, off] = lsn.split("/");
  return (BigInt("0x" + seg) << 32n) | BigInt("0x" + off);
}
