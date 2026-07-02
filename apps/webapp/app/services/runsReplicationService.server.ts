import type { ClickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import {
  type ClickHouse,
  type PayloadInsertArray,
  type TaskRunInsertArray,
  composeTaskRunVersion,
  getPayloadField,
  getTaskRunField,
} from "@internal/clickhouse";
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
import {
  unsafeExtractIdempotencyKeyScope,
  unsafeExtractIdempotencyKeyUser,
} from "@trigger.dev/core/v3/serverOnly";
import { RunAnnotations } from "@trigger.dev/core/v3";
import { type TaskRun } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import EventEmitter from "node:events";
import pLimit from "p-limit";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";
import { calculateErrorFingerprint } from "~/utils/errorFingerprinting";
import { baseWorkerQueue } from "~/runEngine/concerns/workerQueueSplit.server";
import {
  isClickHouseJsonParseError,
  parseRowNumberFromError,
  sanitizeRows,
} from "~/v3/eventRepository/sanitizeRowsOnParseError.server";

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

export type RunsReplicationSource = {
  /**
   * Stable per-source id. MUST be unique across sources. It is the key off
   * which every per-source identity is derived: the LogicalReplicationClient
   * `name` (and therefore the redlock leader-lock resource key), metrics tags,
   * logs. e.g. "legacy" | "new".
   */
  id: string;
  pgConnectionUrl: string;
  slotName: string;
  publicationName: string;
  /** 0 = legacy/control-plane DB, 1 = dedicated run-ops DB. Packed into _version via composeTaskRunVersion. */
  originGeneration: number;
};

export type RunsReplicationServiceOptions = {
  clickhouseFactory: ClickhouseFactory;
  pgConnectionUrl: string;
  serviceName: string;
  slotName: string;
  publicationName: string;
  /**
   * Optional list of replication sources. When provided (and non-empty), the
   * service fans in from each named source into the single shared flush
   * scheduler. When omitted, the scalar `pgConnectionUrl`/`slotName`/
   * `publicationName` are used as a single implicit `"default"` source,
   * preserving the legacy single-source behavior exactly.
   */
  sources?: RunsReplicationSource[];
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
  disableErrorFingerprinting?: boolean;
};

type PostgresTaskRun = TaskRun & { masterQueue: string };

type CurrentTransaction =
  | (Omit<Transaction<TaskRun>, "commitEndLsn" | "replicationLagMs"> & {
      commitEndLsn?: string | null;
      replicationLagMs?: number;
    })
  | null;

type SourceRuntime = {
  source: RunsReplicationSource;
  client: LogicalReplicationClient;
  latestCommitEndLsn: string | null;
  lastAcknowledgedLsn: string | null;
  lastAcknowledgedAt: number | null;
  acknowledgeInterval: NodeJS.Timeout | null;
  currentTransaction: CurrentTransaction;
  currentParseDurationMs: number | null;
};

type TaskRunInsert = {
  _version: bigint;
  run: PostgresTaskRun;
  event: "insert" | "update" | "delete";
};

export type RunsReplicationServiceEvents = {
  message: [{ lsn: string; message: PgoutputMessage; service: RunsReplicationService }];
  batchFlushed: [
    { flushId: string; taskRunInserts: TaskRunInsertArray[]; payloadInserts: PayloadInsertArray[] },
  ];
};

export class RunsReplicationService {
  private _isSubscribed = false;

  /**
   * Per-source runtime state. Each source has its own replication client, leader
   * lock, slot, and in-flight transaction state. All fan in to the single shared
   * _concurrentFlushScheduler. Transaction/LSN state MUST be per-source because
   * logical-replication transactions interleave per stream.
   */
  private _sources: Map<string, SourceRuntime>;

  private _concurrentFlushScheduler: ConcurrentFlushScheduler<TaskRunInsert>;
  private logger: Logger;
  private _isShuttingDown = false;
  private _isShutDownComplete = false;
  private _shutdownStopInFlight = false;
  private _tracer: Tracer;
  private _meter: Meter;
  private _acknowledgeTimeoutMs: number;
  // Retry configuration
  private _insertMaxRetries: number;
  private _insertBaseDelayMs: number;
  private _insertMaxDelayMs: number;
  private _insertStrategy: "insert" | "insert_async";
  private _disablePayloadInsert: boolean;
  private _disableErrorFingerprinting: boolean;

  /**
   * Counts batches that hit a ClickHouse `Cannot parse JSON object` failure
   * that survived one sanitize-retry. These batches are dropped on the floor
   * (returning success-ish to the caller so the retry layer doesn't spin on
   * the same deterministic failure), and we track the drop count for
   * observability. Counter only — does not gate behaviour.
   */
  private _permanentlyDroppedBatches = 0;

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
    this._disableErrorFingerprinting = options.disableErrorFingerprinting ?? false;

    const sources: RunsReplicationSource[] =
      options.sources && options.sources.length > 0
        ? options.sources
        : [
            {
              id: "default",
              pgConnectionUrl: options.pgConnectionUrl,
              slotName: options.slotName,
              publicationName: options.publicationName,
              originGeneration: 0,
            },
          ];

    RunsReplicationService.#validateSources(sources);

    this._sources = new Map<string, SourceRuntime>();

    for (const source of sources) {
      const client = new LogicalReplicationClient({
        pgConfig: {
          connectionString: source.pgConnectionUrl,
        },
        name: `${options.serviceName}:${source.id}`,
        slotName: source.slotName,
        publicationName: source.publicationName,
        table: "TaskRun",
        redisOptions: options.redisOptions,
        autoAcknowledge: false,
        publicationActions: ["insert", "update", "delete"],
        logger:
          options.logger ?? new Logger("LogicalReplicationClient", options.logLevel ?? "info"),
        leaderLockTimeoutMs: options.leaderLockTimeoutMs ?? 30_000,
        leaderLockExtendIntervalMs: options.leaderLockExtendIntervalMs ?? 10_000,
        ackIntervalSeconds: options.ackIntervalSeconds ?? 10,
        leaderLockAcquireAdditionalTimeMs: options.leaderLockAcquireAdditionalTimeMs ?? 10_000,
        leaderLockRetryIntervalMs: options.leaderLockRetryIntervalMs ?? 500,
        tracer: options.tracer,
      });

      const runtime: SourceRuntime = {
        source,
        client,
        latestCommitEndLsn: null,
        lastAcknowledgedLsn: null,
        lastAcknowledgedAt: null,
        acknowledgeInterval: null,
        currentTransaction: null,
        currentParseDurationMs: null,
      };

      this.#wireClientEvents(runtime);

      this._sources.set(source.id, runtime);
    }

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

    // Initialize retry configuration
    this._insertMaxRetries = options.insertMaxRetries ?? 3;
    this._insertBaseDelayMs = options.insertBaseDelayMs ?? 100;
    this._insertMaxDelayMs = options.insertMaxDelayMs ?? 2000;
  }

  static #validateSources(sources: RunsReplicationSource[]) {
    const ids = new Set<string>();
    const slotNames = new Set<string>();
    const originGenerations = new Set<number>();

    for (const source of sources) {
      // Distinct id: a duplicate id derives a duplicate client name -> duplicate
      // redlock leader-lock key -> only one source ever streams.
      if (ids.has(source.id)) {
        throw new Error(
          `RunsReplicationService: duplicate source id "${source.id}" — source ids must be unique`
        );
      }
      ids.add(source.id);

      // Distinct slotName: two consumers on one WAL stream is a data race.
      if (slotNames.has(source.slotName)) {
        throw new Error(
          `RunsReplicationService: duplicate slotName "${source.slotName}" — slot names must be unique across sources`
        );
      }
      slotNames.add(source.slotName);

      // Distinct originGeneration: a shared generation defeats the dedup tiebreak.
      if (originGenerations.has(source.originGeneration)) {
        throw new Error(
          `RunsReplicationService: duplicate originGeneration "${source.originGeneration}" — originGeneration must be unique across sources`
        );
      }
      originGenerations.add(source.originGeneration);
    }
  }

  #wireClientEvents(runtime: SourceRuntime) {
    const { client, source } = runtime;

    client.events.on("data", async ({ lsn, log, parseDuration }) => {
      this.#handleData(runtime, lsn, log, parseDuration);
    });

    client.events.on("heartbeat", async ({ lsn, shouldRespond }) => {
      if (this._isShuttingDown) return;
      if (this._isShutDownComplete) return;

      if (shouldRespond) {
        runtime.lastAcknowledgedLsn = lsn;
        await client.acknowledge(lsn);
      }
    });

    client.events.on("error", (error) => {
      this.logger.error("Replication client error", {
        sourceId: source.id,
        error,
      });
    });

    client.events.on("start", () => {
      this.logger.info("Replication client started", { sourceId: source.id });
    });

    client.events.on("acknowledge", ({ lsn }) => {
      this.logger.debug("Acknowledged", { sourceId: source.id, lsn });
    });

    client.events.on("leaderElection", (isLeader) => {
      this.logger.info("Leader election", { sourceId: source.id, isLeader });
    });
  }

  /** Exposed for tests and metrics — total batches lost to unrecoverable parse errors. */
  get permanentlyDroppedBatches() {
    return this._permanentlyDroppedBatches;
  }

  public async shutdown() {
    if (this._isShuttingDown) return;

    this._isShuttingDown = true;

    this.logger.info("Initiating shutdown of runs replication service");

    const hasCurrentTransaction = Array.from(this._sources.values()).some(
      (runtime) => runtime.currentTransaction !== null
    );

    if (!hasCurrentTransaction) {
      this.logger.info("No transaction to commit, shutting down immediately");
      await Promise.all(Array.from(this._sources.values()).map((runtime) => runtime.client.stop()));
      this._isShutDownComplete = true;
      return;
    }

    this._concurrentFlushScheduler.shutdown();
  }

  async start() {
    for (const runtime of this._sources.values()) {
      this.logger.info("Starting replication client", {
        sourceId: runtime.source.id,
        lastLsn: runtime.latestCommitEndLsn,
      });

      await runtime.client.subscribe(runtime.latestCommitEndLsn ?? undefined);

      runtime.acknowledgeInterval = setInterval(
        () => this.#acknowledgeLatestTransaction(runtime),
        1000
      );
    }

    this._concurrentFlushScheduler.start();
  }

  async stop() {
    for (const runtime of this._sources.values()) {
      this.logger.info("Stopping replication client", { sourceId: runtime.source.id });

      await runtime.client.stop();

      if (runtime.acknowledgeInterval) {
        clearInterval(runtime.acknowledgeInterval);
      }
    }
  }

  async teardown() {
    for (const runtime of this._sources.values()) {
      this.logger.info("Teardown replication client", { sourceId: runtime.source.id });

      await runtime.client.teardown();

      if (runtime.acknowledgeInterval) {
        clearInterval(runtime.acknowledgeInterval);
      }
    }
  }

  async backfill(runs: PostgresTaskRun[], sourceId?: string) {
    const flushId = nanoid();
    // Use current timestamp as LSN (high enough to be above existing data)
    const now = Date.now();
    const syntheticLsn = `${now.toString(16).padStart(8, "0").toUpperCase()}/00000000`;

    // Backfill and live replication of the SAME source share an origin generation
    // and rely on raw-LSN ordering within that generation. Default to the single
    // source self-host uses (gen 0 => passthrough).
    const runtime = sourceId ? this._sources.get(sourceId) : this._sources.values().next().value;

    if (!runtime) {
      throw new Error(
        sourceId
          ? `RunsReplicationService.backfill: no source found with id "${sourceId}"`
          : "RunsReplicationService.backfill: no sources configured"
      );
    }

    const baseVersion = composeTaskRunVersion({
      originGeneration: runtime.source.originGeneration,
      lsnVersion: lsnToUInt64(syntheticLsn),
    });

    await this.#flushBatch(
      flushId,
      runs.map((run, index) => ({
        _version: baseVersion + BigInt(index),
        run,
        event: "insert",
      }))
    );
  }

  #handleData(
    runtime: SourceRuntime,
    lsn: string,
    message: PgoutputMessage,
    parseDuration: bigint
  ) {
    this.logger.debug("Handling data", {
      sourceId: runtime.source.id,
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

        runtime.currentTransaction = {
          beginStartTimestamp: Date.now(),
          commitLsn: message.commitLsn,
          xid: message.xid,
          events: [],
        };

        runtime.currentParseDurationMs = Number(parseDuration) / 1_000_000;

        break;
      }
      case "insert": {
        if (!runtime.currentTransaction) {
          return;
        }

        if (runtime.currentParseDurationMs) {
          runtime.currentParseDurationMs =
            runtime.currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        runtime.currentTransaction.events.push({
          tag: message.tag,
          data: message.new as TaskRun,
          raw: message,
        });
        break;
      }
      case "update": {
        if (!runtime.currentTransaction) {
          return;
        }

        if (runtime.currentParseDurationMs) {
          runtime.currentParseDurationMs =
            runtime.currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        runtime.currentTransaction.events.push({
          tag: message.tag,
          data: message.new as TaskRun,
          raw: message,
        });
        break;
      }
      case "delete": {
        if (!runtime.currentTransaction) {
          return;
        }

        if (runtime.currentParseDurationMs) {
          runtime.currentParseDurationMs =
            runtime.currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        runtime.currentTransaction.events.push({
          tag: message.tag,
          data: message.old as TaskRun,
          raw: message,
        });

        break;
      }
      case "commit": {
        if (!runtime.currentTransaction) {
          return;
        }

        if (runtime.currentParseDurationMs) {
          runtime.currentParseDurationMs =
            runtime.currentParseDurationMs + Number(parseDuration) / 1_000_000;
        }

        const replicationLagMs = Date.now() - Number(message.commitTime / 1000n);
        runtime.currentTransaction.commitEndLsn = message.commitEndLsn;
        runtime.currentTransaction.replicationLagMs = replicationLagMs;
        const transaction = runtime.currentTransaction as Transaction<PostgresTaskRun>;
        runtime.currentTransaction = null;

        if (transaction.commitEndLsn) {
          runtime.latestCommitEndLsn = transaction.commitEndLsn;
        }

        this.#handleTransaction(runtime, transaction);
        break;
      }
      default: {
        this.logger.debug("Unknown message tag", {
          pgMessage: message,
        });
      }
    }
  }

  #handleTransaction(runtime: SourceRuntime, transaction: Transaction<PostgresTaskRun>) {
    if (this._isShutDownComplete) return;

    if (this._isShuttingDown) {
      // A global shutdown stops every source's client; mark complete once all
      // have stopped. Guard against re-firing per incoming transaction, and
      // swallow client.stop() rejections so they don't surface as unhandled.
      if (!this._shutdownStopInFlight) {
        this._shutdownStopInFlight = true;
        Promise.all(Array.from(this._sources.values()).map((r) => r.client.stop()))
          .catch((error) => {
            this.logger.error("Error stopping replication clients during shutdown", { error });
          })
          .finally(() => {
            this._isShutDownComplete = true;
          });
      }
    }

    // If there are no events, do nothing
    if (transaction.events.length === 0) {
      return;
    }

    if (!transaction.commitEndLsn) {
      this.logger.error("Transaction has no commit end lsn", {
        sourceId: runtime.source.id,
        transaction,
      });

      return;
    }

    const lsnToUInt64Start = process.hrtime.bigint();

    // Compose the source's origin generation above the LSN so a higher-generation
    // source wins the ClickHouse dedup tiebreak regardless of raw LSN. Gen 0 (the
    // single-source default) is a passthrough.
    const _version = composeTaskRunVersion({
      originGeneration: runtime.source.originGeneration,
      lsnVersion: lsnToUInt64(transaction.commitEndLsn),
    });

    const lsnToUInt64DurationMs = Number(process.hrtime.bigint() - lsnToUInt64Start) / 1_000_000;

    this._concurrentFlushScheduler.addToBatch(
      transaction.events.map((event) => ({
        _version,
        run: event.data,
        event: event.tag,
      }))
    );

    // Record metrics
    this._replicationLagHistogram.record(transaction.replicationLagMs, {
      source: runtime.source.id,
      generation: runtime.source.originGeneration,
    });

    // Count events by type
    for (const event of transaction.events) {
      this._eventsProcessedCounter.add(1, { event_type: event.tag });
    }

    this.logger.debug("handle_transaction", {
      sourceId: runtime.source.id,
      transaction: {
        xid: transaction.xid,
        commitLsn: transaction.commitLsn,
        commitEndLsn: transaction.commitEndLsn,
        events: transaction.events.length,
        parseDurationMs: runtime.currentParseDurationMs,
        lsnToUInt64DurationMs,
        version: _version.toString(),
      },
    });
  }

  async #acknowledgeLatestTransaction(runtime: SourceRuntime) {
    if (!runtime.latestCommitEndLsn) {
      return;
    }

    if (runtime.lastAcknowledgedLsn === runtime.latestCommitEndLsn) {
      return;
    }

    const now = Date.now();

    if (runtime.lastAcknowledgedAt) {
      const timeSinceLastAcknowledged = now - runtime.lastAcknowledgedAt;
      // If we've already acknowledged within the last second, don't acknowledge again
      if (timeSinceLastAcknowledged < this._acknowledgeTimeoutMs) {
        return;
      }
    }

    runtime.lastAcknowledgedAt = now;
    runtime.lastAcknowledgedLsn = runtime.latestCommitEndLsn;

    this.logger.debug("acknowledge_latest_transaction", {
      sourceId: runtime.source.id,
      commitEndLsn: runtime.latestCommitEndLsn,
      lastAcknowledgedAt: runtime.lastAcknowledgedAt,
    });

    const [ackError] = await tryCatch(runtime.client.acknowledge(runtime.latestCommitEndLsn));

    if (ackError) {
      this.logger.error("Error acknowledging transaction", {
        sourceId: runtime.source.id,
        ackError,
      });
    }

    if (this._isShutDownComplete && runtime.acknowledgeInterval) {
      clearInterval(runtime.acknowledgeInterval);
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
      const preparedInserts = await startSpan(this._tracer, "prepare_inserts", async () => {
        return await Promise.all(batch.map(this.#prepareRunInserts.bind(this)));
      });

      const routeCache = new Map<string, ClickHouse>();
      const groups = new Map<
        ClickHouse,
        { taskRunInserts: TaskRunInsertArray[]; payloadInserts: PayloadInsertArray[] }
      >();

      for (let i = 0; i < batch.length; i++) {
        const batchedRun = batch[i]!;
        const prep = preparedInserts[i]!;
        const { run } = batchedRun;

        if (!run.organizationId || !run.environmentType) {
          continue;
        }

        let client = routeCache.get(run.organizationId);
        if (!client) {
          client = this.options.clickhouseFactory.getClickhouseForOrganizationSync(
            run.organizationId,
            "replication"
          );
          routeCache.set(run.organizationId, client);
        }

        let group = groups.get(client);
        if (!group) {
          group = { taskRunInserts: [], payloadInserts: [] };
          groups.set(client, group);
        }

        if (prep.taskRunInsert) {
          group.taskRunInserts.push(prep.taskRunInsert);
        }
        if (prep.payloadInsert) {
          group.payloadInserts.push(prep.payloadInsert);
        }
      }

      const sortTaskRunInserts = (rows: TaskRunInsertArray[]) =>
        rows.sort((a, b) => {
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

      const sortPayloadInserts = (rows: PayloadInsertArray[]) =>
        rows.sort((a, b) => {
          const aRunId = getPayloadField(a, "run_id");
          const bRunId = getPayloadField(b, "run_id");
          if (aRunId === bRunId) return 0;
          return aRunId < bRunId ? -1 : 1;
        });

      const combinedTaskRunInserts: TaskRunInsertArray[] = [];
      const combinedPayloadInserts: PayloadInsertArray[] = [];
      let taskRunError: Error | null = null;
      let payloadError: Error | null = null;

      for (const [clickhouse, group] of groups) {
        sortTaskRunInserts(group.taskRunInserts);
        sortPayloadInserts(group.payloadInserts);
        combinedTaskRunInserts.push(...group.taskRunInserts);
        combinedPayloadInserts.push(...group.payloadInserts);

        const [trErr, trOutcome] = await this.#insertWithRetry(
          (attempt) => this.#insertTaskRunInserts(clickhouse, group.taskRunInserts, attempt),
          "task run inserts",
          flushId
        );
        if (trErr && !taskRunError) {
          taskRunError = trErr;
        }

        const [plErr, plOutcome] = await this.#insertWithRetry(
          (attempt) => this.#insertPayloadInserts(clickhouse, group.payloadInserts, attempt),
          "payload inserts",
          flushId
        );
        if (plErr && !payloadError) {
          payloadError = plErr;
        }

        // Only count rows that actually landed in ClickHouse. `kind: "dropped"`
        // means the recovery wrapper bailed (sanitizer no-op or sanitize-retry
        // still failed) — those rows never made it, so they must not show up
        // as successful inserts in the per-batch counter.
        if (!trErr && trOutcome?.kind !== "dropped") {
          this._taskRunsInsertedCounter.add(group.taskRunInserts.length);
        }
        if (!plErr && plOutcome?.kind !== "dropped") {
          this._payloadsInsertedCounter.add(group.payloadInserts.length);
        }
      }

      span.setAttribute("task_run_inserts", combinedTaskRunInserts.length);
      span.setAttribute("payload_inserts", combinedPayloadInserts.length);

      this.logger.debug("Flushing inserts", {
        flushId,
        taskRunInserts: combinedTaskRunInserts.length,
        payloadInserts: combinedPayloadInserts.length,
        clickhouseGroups: groups.size,
      });

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
        taskRunInserts: combinedTaskRunInserts.length,
        payloadInserts: combinedPayloadInserts.length,
      });

      this.events.emit("batchFlushed", {
        flushId,
        taskRunInserts: combinedTaskRunInserts,
        payloadInserts: combinedPayloadInserts,
      });

      const flushDurationMs = performance.now() - flushStartTime;
      const hasErrors = taskRunError !== null || payloadError !== null;

      this._batchSizeHistogram.record(batch.length);
      this._flushDurationHistogram.record(flushDurationMs);
      this._batchesFlushedCounter.add(1, { success: !hasErrors });
    });
  }

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

  async #insertTaskRunInserts(
    clickhouse: ClickHouse,
    taskRunInserts: TaskRunInsertArray[],
    attempt: number
  ) {
    if (taskRunInserts.length === 0) {
      return;
    }
    return await startSpan(this._tracer, "insertTaskRunsInserts", async (span) => {
      const doInsert = async () => {
        const [insertError, insertResult] = await clickhouse.taskRuns.insertCompactArrays(
          taskRunInserts,
          { params: { clickhouse_settings: this.#getClickhouseInsertSettings() } }
        );
        if (insertError) {
          this.logger.error("Error inserting task run inserts attempt", {
            error: insertError,
            attempt,
          });
          recordSpanError(span, insertError);
          throw insertError;
        }
        return insertResult;
      };

      return await this.#insertWithJsonParseRecovery(
        taskRunInserts,
        doInsert,
        "task_runs_v2",
        attempt
      );
    });
  }

  async #insertPayloadInserts(
    clickhouse: ClickHouse,
    payloadInserts: PayloadInsertArray[],
    attempt: number
  ) {
    if (payloadInserts.length === 0) {
      return;
    }
    return await startSpan(this._tracer, "insertPayloadInserts", async (span) => {
      const doInsert = async () => {
        const [insertError, insertResult] = await clickhouse.taskRuns.insertPayloadsCompactArrays(
          payloadInserts,
          { params: { clickhouse_settings: this.#getClickhouseInsertSettings() } }
        );
        if (insertError) {
          this.logger.error("Error inserting payload inserts attempt", {
            error: insertError,
            attempt,
          });
          recordSpanError(span, insertError);
          throw insertError;
        }
        return insertResult;
      };

      return await this.#insertWithJsonParseRecovery(
        payloadInserts,
        doInsert,
        "raw_task_runs_payload_v1",
        attempt
      );
    });
  }

  /**
   * Wraps a ClickHouse insert with reactive UTF-16 sanitization for
   * `Cannot parse JSON object` rejections. Mirrors the pattern from
   * `ClickhouseEventRepository.#insertWithJsonParseRecovery` introduced
   * in #3659 — same root cause (lone UTF-16 surrogates in user-provided
   * JSON), same recovery shape:
   *
   *   1. Try the insert. Healthy batches pay zero scan cost.
   *   2. On parse error, walk the whole batch via `sanitizeRows` and
   *      replace any lone-surrogate string with `"[invalid-utf16]"`.
   *   3. Retry once. If the sanitizer found nothing or the retry also
   *      fails with the same error class, drop the batch loudly and
   *      return — do NOT rethrow, otherwise the surrounding
   *      `#insertWithRetry` layer would spin three more times on the
   *      same deterministic failure.
   *   4. Non-parse errors propagate unchanged so the existing
   *      transient-retry path still handles them.
   *
   * The whole-batch scan (rather than slicing on the `at row N` hint) is
   * deliberate: `at row N` semantics under `input_format_parallel_parsing`
   * aren't stable enough to safely skip rows. The cost is bounded because
   * `detectBadJsonStrings` exits in O(1) for clean strings.
   */
  async #insertWithJsonParseRecovery<T extends object>(
    rows: T[],
    doInsert: () => Promise<unknown>,
    contextLabel: string,
    attempt: number
  ): Promise<
    | { kind: "inserted"; insertResult: unknown }
    | { kind: "sanitized"; insertResult: unknown }
    | { kind: "dropped" }
  > {
    try {
      return { kind: "inserted", insertResult: await doInsert() };
    } catch (firstError) {
      if (!isClickHouseJsonParseError(firstError)) throw firstError;

      const firstMessage =
        typeof firstError === "object" && firstError !== null && "message" in firstError
          ? String((firstError as { message?: unknown }).message ?? "")
          : String(firstError);

      const rowHint = parseRowNumberFromError(firstMessage);
      const { rowsTouched, fieldsSanitized } = sanitizeRows(rows);

      if (fieldsSanitized === 0) {
        this._permanentlyDroppedBatches += 1;
        this.logger.error(
          "Dropped batch — ClickHouse JSON parse error but sanitizer found nothing to fix",
          {
            contextLabel,
            attempt,
            batchSize: rows.length,
            clickhouseRowHint: rowHint,
            permanentlyDroppedBatches: this._permanentlyDroppedBatches,
            sampleRow: JSON.stringify(rows[0] ?? null).slice(0, 1024),
            clickhouseError: firstMessage.split("\n")[0],
          }
        );
        return { kind: "dropped" };
      }

      this.logger.warn("Sanitizing batch after ClickHouse JSON parse error", {
        contextLabel,
        attempt,
        batchSize: rows.length,
        clickhouseRowHint: rowHint,
        rowsTouched,
        fieldsSanitized,
        clickhouseError: firstMessage.split("\n")[0],
      });

      try {
        return { kind: "sanitized", insertResult: await doInsert() };
      } catch (retryError) {
        if (!isClickHouseJsonParseError(retryError)) throw retryError;

        this._permanentlyDroppedBatches += 1;
        const retryMessage =
          typeof retryError === "object" && retryError !== null && "message" in retryError
            ? String((retryError as { message?: unknown }).message ?? "")
            : String(retryError);
        this.logger.error(
          "Dropped batch after sanitize-retry still hit ClickHouse JSON parse error",
          {
            contextLabel,
            attempt,
            batchSize: rows.length,
            permanentlyDroppedBatches: this._permanentlyDroppedBatches,
            sampleRow: JSON.stringify(rows[0] ?? null).slice(0, 1024),
            firstError: firstMessage.split("\n")[0],
            retryError: retryMessage.split("\n")[0],
          }
        );
        return { kind: "dropped" };
      }
    }
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
    const errorData = { data: run.error };

    // Calculate error fingerprint for failed runs
    const errorFingerprint =
      !this._disableErrorFingerprinting &&
      ["SYSTEM_FAILURE", "CRASHED", "INTERRUPTED", "COMPLETED_WITH_ERRORS", "TIMED_OUT"].includes(
        run.status
      )
        ? calculateErrorFingerprint(run.error)
        : "";

    const annotations = this.#parseAnnotations(run.annotations);

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
      errorData, // error
      errorFingerprint, // error_fingerprint
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
      baseWorkerQueue(run.masterQueue ?? ""), // worker_queue (raw - operators slice by this)
      run.region ?? "", // region (geo for customers)
      run.planType ?? "", // plan_type
      run.maxDurationInSeconds ?? null, // max_duration_in_seconds
      annotations?.triggerSource ?? "", // trigger_source
      annotations?.rootTriggerSource ?? "", // root_trigger_source
      annotations?.taskKind ?? "", // task_kind
      run.isWarmStart ?? null, // is_warm_start
    ];
  }

  #parseAnnotations(annotations: unknown) {
    return RunAnnotations.safeParse(annotations).data;
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
