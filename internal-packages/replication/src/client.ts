import { tryCatch } from "@trigger.dev/core/utils";
import { Redis, type RedisOptions } from "@internal/redis";
import EventEmitter from "node:events";
import { Client, ClientConfig, Connection } from "pg";
import Redlock, { Lock } from "redlock";
import { createRedisClient } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { LogicalReplicationClientError } from "./errors.js";
import { PgoutputMessage, PgoutputParser, getPgoutputStartReplicationSQL } from "./pgoutput.js";
import { startSpan, trace, Tracer } from "@internal/tracing";

export interface LogicalReplicationClientOptions {
  /**
   * The pg client config.
   */
  pgConfig: ClientConfig;

  /**
   * The name of this LogicalReplicationClient instance, used for leader election.
   */
  name: string;
  /**
   * The table to replicate (for publication creation).
   */
  table: string;
  /**
   * The name of the replication slot to use.
   */
  slotName: string;
  /**
   * The name of the publication to use.
   */
  publicationName: string;
  /**
   * A connected Redis client instance for Redlock.
   */
  redisOptions: RedisOptions;
  /**
   * Whether to automatically acknowledge messages.
   */
  autoAcknowledge?: boolean;
  /**
   * A logger instance for logging.
   */
  logger?: Logger;
  /**
   * The initial leader lock timeout in ms (default: 30000)
   */
  leaderLockTimeoutMs?: number;
  /**
   * The interval in ms to extend the leader lock (default: 10000)
   */
  leaderLockExtendIntervalMs?: number;

  /**
   * The interval in ms to retry acquiring the leader lock (default: 500)
   */
  leaderLockRetryIntervalMs?: number;

  /**
   * The additional time in ms to retry acquiring the leader lock (default: 1000ms)
   */
  leaderLockAcquireAdditionalTimeMs?: number;

  /**
   * The interval in seconds to automatically acknowledge the last LSN if no ack has been sent (default: 10)
   */
  ackIntervalSeconds?: number;

  /**
   * The actions to publish to the publication.
   */
  publicationActions?: Array<"insert" | "update" | "delete" | "truncate">;

  tracer?: Tracer;
}

export type LogicalReplicationClientEvents = {
  leaderElection: [boolean];
  error: [Error];
  data: [{ lsn: string; log: PgoutputMessage; parseDuration: bigint }];
  start: [];
  acknowledge: [{ lsn: string }];
  heartbeat: [{ lsn: string; timestamp: number; shouldRespond: boolean }];
};

export class LogicalReplicationClient {
  private readonly options: LogicalReplicationClientOptions;
  private client: Client | null = null;
  private connection: Connection | null = null;
  private redis: Redis;
  private redlock: Redlock;
  private leaderLock: Lock | null = null;
  public readonly events: EventEmitter<LogicalReplicationClientEvents>;
  private logger: Logger;
  private autoAcknowledge: boolean;
  private lastAcknowledgedLsn: string | null = null;
  private leaderLockTimeoutMs: number;
  private leaderLockExtendIntervalMs: number;
  private leaderLockAcquireAdditionalTimeMs: number;
  private leaderLockRetryIntervalMs: number;
  private leaderLockHeartbeatTimer: NodeJS.Timeout | null = null;
  private ackIntervalSeconds: number;
  private lastAckTimestamp: number = 0;
  private ackIntervalTimer: NodeJS.Timeout | null = null;
  private _isStopped: boolean = false;
  private _tracer: Tracer;

  public get lastLsn(): string {
    return this.lastAcknowledgedLsn ?? "0/00000000";
  }

  public get isStopped(): boolean {
    return this._isStopped;
  }

  constructor(options: LogicalReplicationClientOptions) {
    this.options = options;
    this.logger = options.logger ?? new Logger("LogicalReplicationClient", "info");
    this._tracer = options.tracer ?? trace.getTracer("logical-replication-client");

    this.autoAcknowledge =
      typeof options.autoAcknowledge === "boolean" ? options.autoAcknowledge : true;

    this.leaderLockTimeoutMs = options.leaderLockTimeoutMs ?? 30000;
    this.leaderLockExtendIntervalMs = options.leaderLockExtendIntervalMs ?? 10000;
    this.leaderLockAcquireAdditionalTimeMs = options.leaderLockAcquireAdditionalTimeMs ?? 1000;
    this.leaderLockRetryIntervalMs = options.leaderLockRetryIntervalMs ?? 500;
    this.ackIntervalSeconds = options.ackIntervalSeconds ?? 10;

    this.redis = createRedisClient(
      {
        ...options.redisOptions,
        keyPrefix: `${options.redisOptions.keyPrefix}logical-replication-client:`,
      },
      {
        onError: (error) => {
          this.logger.error(`RunLock redis client error:`, {
            error,
            keyPrefix: options.redisOptions.keyPrefix,
          });
        },
      }
    );

    this.redlock = new Redlock([this.redis], {
      retryCount: 0,
    });
    this.events = new EventEmitter<LogicalReplicationClientEvents>();
  }

  public async stop(): Promise<this> {
    return await startSpan(this._tracer, "logical_replication_client.stop", async (span) => {
      if (this._isStopped) return this;

      span.setAttribute("replication_client.name", this.options.name);
      span.setAttribute("replication_client.table", this.options.table);
      span.setAttribute("replication_client.slot_name", this.options.slotName);
      span.setAttribute("replication_client.publication_name", this.options.publicationName);

      this._isStopped = true;
      // Clean up leader lock heartbeat
      if (this.leaderLockHeartbeatTimer) {
        clearInterval(this.leaderLockHeartbeatTimer);
        this.leaderLockHeartbeatTimer = null;
      }
      // Clean up ack interval
      if (this.ackIntervalTimer) {
        clearInterval(this.ackIntervalTimer);
        this.ackIntervalTimer = null;
      }
      // Release leader lock if held
      await this.#releaseLeaderLock();

      this.connection?.removeAllListeners();
      this.connection = null;

      if (this.client) {
        this.client.removeAllListeners();

        const [endError] = await tryCatch(this.client.end());

        if (endError) {
          this.logger.error("Failed to end client", {
            name: this.options.name,
            error: endError,
          });
        } else {
          this.logger.info("Ended client", {
            name: this.options.name,
          });
        }
        this.client = null;
      }

      // clear any intervals
      if (this.leaderLockHeartbeatTimer) {
        clearInterval(this.leaderLockHeartbeatTimer);
        this.leaderLockHeartbeatTimer = null;
      }

      if (this.ackIntervalTimer) {
        clearInterval(this.ackIntervalTimer);
        this.ackIntervalTimer = null;
      }

      return this;
    });
  }

  public async teardown(): Promise<boolean> {
    await this.stop();

    // Acquire the leaderLock
    const leaderLockAcquired = await this.#acquireLeaderLock();

    if (!leaderLockAcquired) {
      return false;
    }

    this.client = new Client({
      ...this.options.pgConfig,
      // @ts-expect-error
      replication: "database",
      application_name: this.options.name,
    });
    await this.client.connect();

    // Drop the slot
    const slotDropped = await this.#dropSlot();

    await this.client.end();
    this.client = null;

    await this.#releaseLeaderLock();

    return slotDropped;
  }

  public async subscribe(startLsn?: string): Promise<this> {
    await this.stop();

    this.lastAcknowledgedLsn = startLsn ?? this.lastAcknowledgedLsn;

    this.logger.info("Subscribing to logical replication", {
      name: this.options.name,
      table: this.options.table,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      startLsn,
    });

    // 1. Leader election
    const leaderLockAcquired = await this.#acquireLeaderLock();

    if (!leaderLockAcquired) {
      this.events.emit("leaderElection", false);
      return this.stop();
    }

    this.events.emit("leaderElection", true);

    this.logger.info("Leader election successful", {
      name: this.options.name,
      table: this.options.table,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      startLsn,
    });

    // Start leader lock heartbeat
    this.#startLeaderLockHeartbeat();

    // Start auto-acknowledge interval
    this.#startAckInterval();

    // 2. Connect pg client
    this.client = new Client({
      ...this.options.pgConfig,
      // @ts-expect-error
      replication: "database",
      application_name: this.options.name,
    });
    await this.client.connect();
    // @ts-ignore
    this.connection = this.client.connection;

    const publicationCreated = await this.#createPublication();

    if (!publicationCreated) {
      return this.stop();
    }

    this.logger.info("Publication created", {
      name: this.options.name,
      table: this.options.table,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      startLsn,
    });

    const slotCreated = await this.#createSlot();

    if (!slotCreated) {
      return this.stop();
    }

    this.logger.info("Slot created", {
      name: this.options.name,
      table: this.options.table,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      startLsn,
    });

    // 5. Start replication (pgoutput)
    const parser = new PgoutputParser();
    const sql = getPgoutputStartReplicationSQL(this.options.slotName, this.lastLsn, {
      protoVersion: 1,
      publicationNames: [this.options.publicationName],
      messages: false,
    });

    // 6. Listen for replication events (copyData, etc.)
    if (!this.connection) {
      this.events.emit(
        "error",
        new LogicalReplicationClientError("No connection after starting replication")
      );
      return this.stop();
    }

    this.connection.once("replicationStart", () => {
      this._isStopped = false;
      this.events.emit("start");
    });

    this.connection.on(
      "copyData",
      async ({ chunk: buffer }: { length: number; chunk: Buffer; name: string }) => {
        // pgoutput protocol: 0x77 = XLogData, 0x6b = Primary keepalive
        if (buffer[0] !== 0x77 && buffer[0] !== 0x6b) {
          this.logger.warn("Unknown replication message type", { byte: buffer[0] });
          return;
        }
        const lsn =
          buffer.readUInt32BE(1).toString(16).toUpperCase() +
          "/" +
          buffer.readUInt32BE(5).toString(16).toUpperCase();

        if (buffer[0] === 0x77) {
          // XLogData
          try {
            const start = process.hrtime.bigint();
            const log = parser.parse(buffer.subarray(25));
            const duration = process.hrtime.bigint() - start;
            this.events.emit("data", { lsn, log, parseDuration: duration });
            await this.#acknowledge(lsn);
          } catch (err) {
            this.logger.error("Failed to parse XLogData", { error: err });
            this.events.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
        } else if (buffer[0] === 0x6b) {
          // Primary keepalive message
          const timestamp = Math.floor(
            buffer.readUInt32BE(9) * 4294967.296 + buffer.readUInt32BE(13) / 1000 + 946080000000
          );
          const shouldRespond = !!buffer.readInt8(17);
          this.events.emit("heartbeat", { lsn, timestamp, shouldRespond });
          if (shouldRespond) {
            await this.#acknowledge(lsn);
          }
        }

        this.lastAcknowledgedLsn = lsn;
      }
    );

    // 7. Handle errors and cleanup
    this.client.on("error", (err) => {
      this.events.emit("error", err);
    });

    this.logger.info("Started replication", {
      name: this.options.name,
      table: this.options.table,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      startLsn,
      sql: sql.replace(/\s+/g, " "),
    });

    // Start the replication stream
    this.client.query(sql).catch((err) => {
      this.logger.error("Failed to start replication", {
        name: this.options.name,
        table: this.options.table,
        slotName: this.options.slotName,
        publicationName: this.options.publicationName,
        error: err,
      });

      this.events.emit("error", err);
      return this.stop();
    });

    return this;
  }

  async #createPublication(): Promise<boolean> {
    if (!this.client) {
      this.events.emit("error", new LogicalReplicationClientError("Client not connected"));
      return false;
    }

    const publicationExists = await this.#doesPublicationExist();

    if (publicationExists) {
      // Validate the existing publication is correctly configured
      const validationError = await this.#validatePublicationConfiguration();

      if (validationError) {
        this.logger.error("Publication exists but is misconfigured", {
          name: this.options.name,
          table: this.options.table,
          slotName: this.options.slotName,
          publicationName: this.options.publicationName,
          error: validationError,
        });

        this.events.emit("error", new LogicalReplicationClientError(validationError));
        return false;
      }

      this.logger.info("Publication exists and is correctly configured", {
        name: this.options.name,
        table: this.options.table,
        publicationName: this.options.publicationName,
      });

      return true;
    }

    const [createError] = await tryCatch(
      this.client.query(
        `CREATE PUBLICATION "${this.options.publicationName}" FOR TABLE "${this.options.table}" ${
          this.options.publicationActions
            ? `WITH (publish = '${this.options.publicationActions.join(", ")}')`
            : ""
        };`
      )
    );

    if (createError) {
      this.logger.error("Failed to create publication", {
        name: this.options.name,
        table: this.options.table,
        slotName: this.options.slotName,
        publicationName: this.options.publicationName,
        error: createError,
      });

      this.events.emit("error", createError);
      return false;
    }

    return true;
  }

  async #doesPublicationExist(): Promise<boolean> {
    if (!this.client) {
      this.events.emit(
        "error",
        new LogicalReplicationClientError("Cannot check if publication exists")
      );
      return false;
    }

    const res = await this.client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = '${this.options.publicationName}');`
    );

    return res.rows[0].exists;
  }

  async #validatePublicationConfiguration(): Promise<string | null> {
    if (!this.client) {
      return "Cannot validate publication configuration: client not connected";
    }

    // Check if the publication has the correct table
    const tablesRes = await this.client.query(
      `SELECT schemaname, tablename 
       FROM pg_publication_tables 
       WHERE pubname = '${this.options.publicationName}';`
    );

    const tables = tablesRes.rows;
    const expectedTable = this.options.table;

    // Check if the table is in the publication
    const hasTable = tables.some(
      (row) => row.tablename === expectedTable && row.schemaname === "public"
    );

    if (!hasTable) {
      if (tables.length === 0) {
        return `Publication '${this.options.publicationName}' exists but has NO TABLES configured. Expected table: "public.${expectedTable}". Run: ALTER PUBLICATION ${this.options.publicationName} ADD TABLE "${expectedTable}";`;
      } else {
        const tableList = tables.map((t) => `"${t.schemaname}"."${t.tablename}"`).join(", ");
        return `Publication '${this.options.publicationName}' exists but does not include the required table "public.${expectedTable}". Current tables: ${tableList}. Run: ALTER PUBLICATION ${this.options.publicationName} ADD TABLE "${expectedTable}";`;
      }
    }

    // Check if the publication has the correct actions configured
    if (this.options.publicationActions && this.options.publicationActions.length > 0) {
      const actionsRes = await this.client.query(
        `SELECT pubinsert, pubupdate, pubdelete, pubtruncate 
         FROM pg_publication 
         WHERE pubname = '${this.options.publicationName}';`
      );

      if (actionsRes.rows.length === 0) {
        return `Publication '${this.options.publicationName}' not found when checking actions`;
      }

      const actualActions = actionsRes.rows[0];
      const missingActions: string[] = [];

      for (const action of this.options.publicationActions) {
        switch (action) {
          case "insert":
            if (!actualActions.pubinsert) missingActions.push("insert");
            break;
          case "update":
            if (!actualActions.pubupdate) missingActions.push("update");
            break;
          case "delete":
            if (!actualActions.pubdelete) missingActions.push("delete");
            break;
          case "truncate":
            if (!actualActions.pubtruncate) missingActions.push("truncate");
            break;
        }
      }

      if (missingActions.length > 0) {
        const currentActions: string[] = [];
        if (actualActions.pubinsert) currentActions.push("insert");
        if (actualActions.pubupdate) currentActions.push("update");
        if (actualActions.pubdelete) currentActions.push("delete");
        if (actualActions.pubtruncate) currentActions.push("truncate");

        return `Publication '${
          this.options.publicationName
        }' is missing required actions. Expected: [${this.options.publicationActions.join(
          ", "
        )}], Current: [${currentActions.join(", ")}], Missing: [${missingActions.join(
          ", "
        )}]. Run: ALTER PUBLICATION ${
          this.options.publicationName
        } SET (publish = '${this.options.publicationActions.join(", ")}');`;
      }
    }

    // All validations passed
    return null;
  }

  async #createSlot(): Promise<boolean> {
    if (!this.client) {
      this.events.emit("error", new LogicalReplicationClientError("Cannot create slot"));
      return false;
    }

    if (await this.#doesSlotExist()) {
      return true;
    }

    const [createError] = await tryCatch(
      this.client.query(
        `SELECT * FROM pg_create_logical_replication_slot('${this.options.slotName}', 'pgoutput')`
      )
    );

    if (createError) {
      this.logger.error("Failed to create slot", {
        name: this.options.name,
        table: this.options.table,
        slotName: this.options.slotName,
        publicationName: this.options.publicationName,
        error: createError,
      });

      this.events.emit("error", createError);
      return false;
    }

    return true;
  }

  async #doesSlotExist(): Promise<boolean> {
    if (!this.client) {
      this.events.emit("error", new LogicalReplicationClientError("Cannot check if slot exists"));
      return false;
    }

    const res = await this.client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${this.options.slotName}');`
    );

    return res.rows[0].exists;
  }

  async #dropSlot(): Promise<boolean> {
    if (!this.client) {
      this.events.emit("error", new LogicalReplicationClientError("Cannot drop slot"));
      return false;
    }

    const [dropError] = await tryCatch(
      this.client.query(`SELECT pg_drop_replication_slot('${this.options.slotName}');`)
    );

    if (dropError) {
      this.logger.error("Failed to drop slot", {
        name: this.options.name,
        table: this.options.table,
        slotName: this.options.slotName,
        publicationName: this.options.publicationName,
        error: dropError,
      });

      this.events.emit("error", dropError);
    }

    return true;
  }

  async #acknowledge(lsn: string): Promise<void> {
    if (!this.autoAcknowledge) return;
    this.events.emit("acknowledge", { lsn });
    await this.acknowledge(lsn);
  }

  public async acknowledge(lsn: string): Promise<boolean> {
    if (this._isStopped) return false;
    if (!this.connection) return false;

    return await startSpan(this._tracer, "logical_replication_client.acknowledge", async (span) => {
      span.setAttribute("replication_client.lsn", lsn);
      span.setAttribute("replication_client.name", this.options.name);
      span.setAttribute("replication_client.table", this.options.table);
      span.setAttribute("replication_client.slot_name", this.options.slotName);
      span.setAttribute("replication_client.publication_name", this.options.publicationName);

      // WAL LSN split
      const slice = lsn.split("/");
      let [upperWAL, lowerWAL]: [number, number] = [parseInt(slice[0], 16), parseInt(slice[1], 16)];
      // Timestamp as microseconds since midnight 2000-01-01
      const now = Date.now() - 946080000000;
      const upperTimestamp = Math.floor(now / 4294967.296);
      const lowerTimestamp = Math.floor(now - upperTimestamp * 4294967.296);
      if (lowerWAL === 4294967295) {
        upperWAL = upperWAL + 1;
        lowerWAL = 0;
      } else {
        lowerWAL = lowerWAL + 1;
      }
      const response = Buffer.alloc(34);
      response.fill(0x72); // 'r'
      response.writeUInt32BE(upperWAL, 1);
      response.writeUInt32BE(lowerWAL, 5);
      response.writeUInt32BE(upperWAL, 9);
      response.writeUInt32BE(lowerWAL, 13);
      response.writeUInt32BE(upperWAL, 17);
      response.writeUInt32BE(lowerWAL, 21);
      response.writeUInt32BE(upperTimestamp, 25);
      response.writeUInt32BE(lowerTimestamp, 29);
      response.writeInt8(0, 33);
      // @ts-ignore
      this.connection.sendCopyFromChunk(response);
      this.lastAckTimestamp = Date.now();
      return true;
    });
  }

  async #acquireLeaderLock(): Promise<boolean> {
    const startTime = Date.now();
    const maxWaitTime = this.leaderLockTimeoutMs + this.leaderLockAcquireAdditionalTimeMs;

    this.logger.debug("Acquiring leader lock", {
      name: this.options.name,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      maxWaitTime,
    });

    let attempt = 0;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        this.leaderLock = await this.redlock.acquire(
          [`logical-replication-client:${this.options.name}`],
          this.leaderLockTimeoutMs
        );

        this.logger.debug("Acquired leader lock", {
          name: this.options.name,
          slotName: this.options.slotName,
          publicationName: this.options.publicationName,
          lockTimeoutMs: this.leaderLockTimeoutMs,
          lockExtendIntervalMs: this.leaderLockExtendIntervalMs,
          lock: this.leaderLock,
          attempt,
        });
        return true;
      } catch (err) {
        attempt++;

        this.logger.debug("Failed to acquire leader lock, retrying", {
          name: this.options.name,
          slotName: this.options.slotName,
          publicationName: this.options.publicationName,
          attempt,
          retryIntervalMs: this.leaderLockRetryIntervalMs,
          error: err,
        });

        await new Promise((resolve) => setTimeout(resolve, this.leaderLockRetryIntervalMs));
      }
    }

    this.logger.error("Leader election failed after retries", {
      name: this.options.name,
      table: this.options.table,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      totalAttempts: attempt,
      totalWaitTimeMs: Date.now() - startTime,
    });
    return false;
  }

  async #releaseLeaderLock() {
    if (!this.leaderLock) return;

    this.logger.debug("Releasing leader lock", {
      name: this.options.name,
      slotName: this.options.slotName,
      publicationName: this.options.publicationName,
      lockTimeoutMs: this.leaderLockTimeoutMs,
      lockExtendIntervalMs: this.leaderLockExtendIntervalMs,
      lock: this.leaderLock,
    });

    const [releaseError] = await tryCatch(this.leaderLock.release());
    this.leaderLock = null;

    if (releaseError) {
      this.logger.error("Failed to release leader lock", {
        name: this.options.name,
        error: releaseError,
      });
    }
  }

  async #startLeaderLockHeartbeat() {
    if (this.leaderLockHeartbeatTimer) {
      clearInterval(this.leaderLockHeartbeatTimer);
    }
    if (!this.leaderLock) return;
    this.leaderLockHeartbeatTimer = setInterval(async () => {
      if (!this.leaderLock) return;
      if (this._isStopped) return;
      try {
        this.leaderLock = await this.leaderLock.extend(this.leaderLockTimeoutMs);
        this.logger.debug("Extended leader lock", {
          name: this.options.name,
          slotName: this.options.slotName,
          publicationName: this.options.publicationName,
          lockTimeoutMs: this.leaderLockTimeoutMs,
          lockExtendIntervalMs: this.leaderLockExtendIntervalMs,
        });
      } catch (err) {
        this.logger.error("Failed to extend leader lock", {
          name: this.options.name,
          slotName: this.options.slotName,
          publicationName: this.options.publicationName,
          error: err,
          lockTimeoutMs: this.leaderLockTimeoutMs,
          lockExtendIntervalMs: this.leaderLockExtendIntervalMs,
        });
        // Optionally emit an error or handle loss of leadership
        this.events.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }, this.leaderLockExtendIntervalMs);
  }

  #startAckInterval() {
    if (this.ackIntervalTimer) {
      clearInterval(this.ackIntervalTimer);
    }
    if (!this.autoAcknowledge || this.ackIntervalSeconds <= 0) return;
    this.ackIntervalTimer = setInterval(async () => {
      if (this._isStopped) return;
      const now = Date.now();
      if (
        this.lastAcknowledgedLsn &&
        now - this.lastAckTimestamp > this.ackIntervalSeconds * 1000
      ) {
        await this.acknowledge(this.lastAcknowledgedLsn);
      }
    }, 1000);
  }
}
