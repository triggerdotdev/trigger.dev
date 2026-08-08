import type { ClickHouse, WebhookDeliveryInsertArray } from "@internal/clickhouse";
import { getWebhookDeliveryField } from "@internal/clickhouse";
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
import { type WebhookDelivery } from "@trigger.dev/database";
import EventEmitter from "node:events";
import type { ClickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { ConcurrentFlushScheduler } from "./runsReplicationService.server";

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

export type WebhookDeliveriesReplicationServiceOptions = {
  clickhouseFactory: ClickhouseFactory;
  pgConnectionUrl: string;
  serviceName: string;
  slotName: string;
  publicationName: string;
  publishViaPartitionRoot?: boolean;
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
};

type WebhookDeliveryInsert = {
  _version: bigint;
  delivery: WebhookDelivery;
  event: "insert" | "update" | "delete";
};

export type WebhookDeliveriesReplicationServiceEvents = {
  message: [
    { lsn: string; message: PgoutputMessage; service: WebhookDeliveriesReplicationService },
  ];
  batchFlushed: [{ flushId: string; deliveryInserts: WebhookDeliveryInsertArray[] }];
};

export class WebhookDeliveriesReplicationService {
  private _isSubscribed = false;
  private _currentTransaction:
    | (Omit<Transaction<WebhookDelivery>, "commitEndLsn" | "replicationLagMs"> & {
        commitEndLsn?: string | null;
        replicationLagMs?: number;
      })
    | null = null;

  private _replicationClient: LogicalReplicationClient;
  private _concurrentFlushScheduler: ConcurrentFlushScheduler<WebhookDeliveryInsert>;
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

  // Metrics
  private _replicationLagHistogram: Histogram;
  private _batchesFlushedCounter: Counter;
  private _batchSizeHistogram: Histogram;
  private _deliveriesInsertedCounter: Counter;
  private _insertRetriesCounter: Counter;
  private _eventsProcessedCounter: Counter;
  private _flushDurationHistogram: Histogram;

  public readonly events: EventEmitter<WebhookDeliveriesReplicationServiceEvents>;

  constructor(private readonly options: WebhookDeliveriesReplicationServiceOptions) {
    this.logger =
      options.logger ??
      new Logger("WebhookDeliveriesReplicationService", options.logLevel ?? "info");
    this.events = new EventEmitter();
    this._tracer = options.tracer ?? trace.getTracer("webhook-deliveries-replication-service");
    this._meter = options.meter ?? getMeter("webhook-deliveries-replication");

    // Initialize metrics
    this._replicationLagHistogram = this._meter.createHistogram(
      "webhook_deliveries_replication.replication_lag_ms",
      {
        description: "Replication lag from Postgres commit to processing",
        unit: "ms",
      }
    );

    this._batchesFlushedCounter = this._meter.createCounter(
      "webhook_deliveries_replication.batches_flushed",
      {
        description: "Total batches flushed to ClickHouse",
      }
    );

    this._batchSizeHistogram = this._meter.createHistogram(
      "webhook_deliveries_replication.batch_size",
      {
        description: "Number of items per batch flush",
        unit: "items",
      }
    );

    this._deliveriesInsertedCounter = this._meter.createCounter(
      "webhook_deliveries_replication.deliveries_inserted",
      {
        description: "Webhook delivery inserts to ClickHouse",
        unit: "inserts",
      }
    );

    this._insertRetriesCounter = this._meter.createCounter(
      "webhook_deliveries_replication.insert_retries",
      {
        description: "Insert retry attempts",
      }
    );

    this._eventsProcessedCounter = this._meter.createCounter(
      "webhook_deliveries_replication.events_processed",
      {
        description: "Replication events processed (inserts, updates, deletes)",
      }
    );

    this._flushDurationHistogram = this._meter.createHistogram(
      "webhook_deliveries_replication.flush_duration_ms",
      {
        description: "Duration of batch flush operations",
        unit: "ms",
      }
    );

    this._acknowledgeTimeoutMs = options.acknowledgeTimeoutMs ?? 1_000;

    this._insertStrategy = options.insertStrategy ?? "insert";

    this._replicationClient = new LogicalReplicationClient({
      pgConfig: {
        connectionString: options.pgConnectionUrl,
      },
      name: options.serviceName,
      slotName: options.slotName,
      publicationName: options.publicationName,
      table: "WebhookDelivery",
      publishViaPartitionRoot: options.publishViaPartitionRoot,
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

    this._concurrentFlushScheduler = new ConcurrentFlushScheduler<WebhookDeliveryInsert>({
      batchSize: options.flushBatchSize ?? 50,
      flushInterval: options.flushIntervalMs ?? 100,
      maxConcurrency: options.maxFlushConcurrency ?? 100,
      callback: this.#flushBatch.bind(this),
      // Key-based deduplication to reduce duplicates sent to ClickHouse
      getKey: (item) => {
        if (!item?.delivery?.id) {
          this.logger.warn("Skipping replication event with null delivery", { event: item });
          return null;
        }
        return `${item.event}_${item.delivery.id}`;
      },
      // Keep the delivery with the higher version (latest)
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

    this.logger.info("Initiating shutdown of webhook deliveries replication service");

    if (!this._currentTransaction) {
      this.logger.info("No transaction to commit, shutting down immediately");
      await this._replicationClient.stop();
      this._isSubscribed = false;
      this._isShutDownComplete = true;
      return;
    }

    this._concurrentFlushScheduler.shutdown();
  }

  async start() {
    if (this._isSubscribed) {
      this.logger.debug("Replication client already started, skipping start");
      return;
    }

    this.logger.info("Starting replication client", {
      lastLsn: this._latestCommitEndLsn,
    });

    await this._replicationClient.subscribe(this._latestCommitEndLsn ?? undefined);

    this._acknowledgeInterval = setInterval(this.#acknowledgeLatestTransaction.bind(this), 1000);
    this._concurrentFlushScheduler.start();
    this._isSubscribed = true;
  }

  async stop() {
    this.logger.info("Stopping replication client");

    await this._replicationClient.stop();

    if (this._acknowledgeInterval) {
      clearInterval(this._acknowledgeInterval);
      this._acknowledgeInterval = null;
    }

    this._isSubscribed = false;
  }

  async teardown() {
    this.logger.info("Teardown replication client");

    await this._replicationClient.teardown();

    if (this._acknowledgeInterval) {
      clearInterval(this._acknowledgeInterval);
      this._acknowledgeInterval = null;
    }

    this._isSubscribed = false;
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
          data: message.new as WebhookDelivery,
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
          data: message.new as WebhookDelivery,
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
          data: message.old as WebhookDelivery,
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
        const transaction = this._currentTransaction as Transaction<WebhookDelivery>;
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

  #handleTransaction(transaction: Transaction<WebhookDelivery>) {
    if (this._isShutDownComplete) return;

    if (this._isShuttingDown) {
      this._replicationClient.stop().finally(() => {
        this._isSubscribed = false;
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
        delivery: event.data,
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

    this.logger.debug("acknowledge_latest_transaction", {
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

  async #flushBatch(flushId: string, batch: Array<WebhookDeliveryInsert>) {
    if (batch.length === 0) {
      return;
    }

    this.logger.debug("Flushing batch", {
      flushId,
      batchSize: batch.length,
    });

    const flushStartTime = performance.now();

    await startSpan(this._tracer, "flushBatch", async (span) => {
      const routeCache = new Map<string, ClickHouse>();
      const groups = new Map<ClickHouse, { deliveryInserts: WebhookDeliveryInsertArray[] }>();

      for (const item of batch) {
        if (!item.delivery.organizationId) {
          continue;
        }

        let client = routeCache.get(item.delivery.organizationId);
        if (!client) {
          client = this.options.clickhouseFactory.getClickhouseForOrganizationSync(
            item.delivery.organizationId,
            "webhook_deliveries_replication"
          );
          routeCache.set(item.delivery.organizationId, client);
        }

        let group = groups.get(client);
        if (!group) {
          group = { deliveryInserts: [] };
          groups.set(client, group);
        }

        group.deliveryInserts.push(
          toWebhookDeliveryInsertArray(item.delivery, item._version, item.event === "delete")
        );
      }

      // batch inserts in clickhouse are more performant if the items
      // are pre-sorted by the primary key
      const sortDeliveryInserts = (rows: WebhookDeliveryInsertArray[]) =>
        rows.sort((a, b) => {
          const aOrgId = getWebhookDeliveryField(a, "organization_id");
          const bOrgId = getWebhookDeliveryField(b, "organization_id");
          if (aOrgId !== bOrgId) {
            return aOrgId < bOrgId ? -1 : 1;
          }
          const aProjId = getWebhookDeliveryField(a, "project_id");
          const bProjId = getWebhookDeliveryField(b, "project_id");
          if (aProjId !== bProjId) {
            return aProjId < bProjId ? -1 : 1;
          }
          const aEnvId = getWebhookDeliveryField(a, "environment_id");
          const bEnvId = getWebhookDeliveryField(b, "environment_id");
          if (aEnvId !== bEnvId) {
            return aEnvId < bEnvId ? -1 : 1;
          }
          const aCreatedAt = getWebhookDeliveryField(a, "created_at");
          const bCreatedAt = getWebhookDeliveryField(b, "created_at");
          if (aCreatedAt !== bCreatedAt) {
            return aCreatedAt - bCreatedAt;
          }
          const aDeliveryId = getWebhookDeliveryField(a, "delivery_id");
          const bDeliveryId = getWebhookDeliveryField(b, "delivery_id");
          if (aDeliveryId === bDeliveryId) return 0;
          return aDeliveryId < bDeliveryId ? -1 : 1;
        });

      const combinedDeliveryInserts: WebhookDeliveryInsertArray[] = [];
      let deliveryError: Error | null = null;

      // Sequential per-group flush — matches runsReplicationService for the same reason
      // (parallel writes have hit Linux net.ipv4.tcp_wmem buffer pressure at high throughput).
      for (const [clickhouse, group] of groups) {
        sortDeliveryInserts(group.deliveryInserts);
        combinedDeliveryInserts.push(...group.deliveryInserts);

        const [insErr] = await this.#insertWithRetry(
          (attempt) => this.#insertDeliveryInserts(clickhouse, group.deliveryInserts, attempt),
          "delivery inserts",
          flushId
        );
        if (insErr && !deliveryError) {
          deliveryError = insErr;
        }

        if (!insErr) {
          this._deliveriesInsertedCounter.add(group.deliveryInserts.length);
        }
      }

      span.setAttribute("delivery_inserts", combinedDeliveryInserts.length);

      this.logger.debug("Flushing inserts", {
        flushId,
        deliveryInserts: combinedDeliveryInserts.length,
        clickhouseGroups: groups.size,
      });

      if (deliveryError) {
        this.logger.error("Error inserting delivery inserts", {
          error: deliveryError,
          flushId,
        });
        recordSpanError(span, deliveryError);
      }

      this.logger.debug("Flushed inserts", {
        flushId,
        deliveryInserts: combinedDeliveryInserts.length,
      });

      this.events.emit("batchFlushed", { flushId, deliveryInserts: combinedDeliveryInserts });

      const flushDurationMs = performance.now() - flushStartTime;
      const hasErrors = deliveryError !== null;

      this._batchSizeHistogram.record(batch.length);
      this._flushDurationHistogram.record(flushDurationMs);
      this._batchesFlushedCounter.add(1, { success: !hasErrors });
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

          this.logger.warn(`Retrying WebhookDeliveriesReplication insert due to error`, {
            operationName,
            flushId,
            attempt,
            maxRetries: this._insertMaxRetries,
            error: lastError.message,
            delay,
          });

          // Record retry metric
          this._insertRetriesCounter.add(1, { operation: "webhook_deliveries" });

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

  async #insertDeliveryInserts(
    clickhouse: ClickHouse,
    deliveryInserts: WebhookDeliveryInsertArray[],
    attempt: number
  ) {
    if (deliveryInserts.length === 0) {
      return;
    }
    return await startSpan(this._tracer, "insertDeliveryInserts", async (span) => {
      const [insertError, insertResult] = await clickhouse.webhookDeliveries.insertCompactArrays(
        deliveryInserts,
        {
          params: {
            clickhouse_settings: this.#getClickhouseInsertSettings(),
          },
        }
      );

      if (insertError) {
        this.logger.error("Error inserting delivery inserts attempt", {
          error: insertError,
          attempt,
        });

        recordSpanError(span, insertError);
        throw insertError;
      }

      return insertResult;
    });
  }
}

function toWebhookDeliveryInsertArray(
  delivery: WebhookDelivery,
  version: bigint,
  isDeleted: boolean
): WebhookDeliveryInsertArray {
  return [
    delivery.runtimeEnvironmentId,
    delivery.organizationId,
    delivery.projectId,
    delivery.id,
    delivery.webhookEndpointId,
    delivery.environmentType,
    delivery.friendlyId,
    delivery.externalDeliveryId ?? "",
    delivery.runId ?? "",
    delivery.status,
    delivery.isTest ? 1 : 0,
    delivery.createdAt.getTime(),
    delivery.updatedAt.getTime(),
    version.toString(),
    isDeleted ? 1 : 0,
  ];
}

function lsnToUInt64(lsn: string): bigint {
  const [seg, off] = lsn.split("/");
  return (BigInt("0x" + seg) << 32n) | BigInt("0x" + off);
}
