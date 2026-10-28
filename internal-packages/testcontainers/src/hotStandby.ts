import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { GenericContainer, type StartedNetwork, Wait } from "testcontainers";
import { getRunOpsSchemaSql, runSql, withCiResourceLimits } from "./utils";

/**
 * A real Postgres 17 primary streaming to a real hot standby, for code that must survive what only a
 * standby does: cancel a running read when WAL replay conflicts with it ("canceling statement due to
 * conflict with recovery", SQLSTATE 40001, or 40P01 for a buffer deadlock with replay). The standby
 * starts with `max_standby_streaming_delay = 0`, so replay cancels a conflicting read at once.
 *
 * The primary's database has the run-ops schema.
 */
export type HotStandby = {
  primaryUrl: string;
  standbyUrl: string;
  /** Run statements in order on ONE primary connection (so BEGIN ... PREPARE works). */
  primarySql(statements: string | readonly string[]): Promise<void>;
  /** Wait until the standby has replayed everything the primary has written so far. */
  waitForReplay(timeoutMs?: number): Promise<void>;
  /** Resolve once replay is waiting for a standby read to release a buffer pin. */
  waitForReplayBlockedOnPin(timeoutMs?: number): Promise<void>;
  /** How long replay waits on a conflicting read before cancelling it (ms; 0 = at once). */
  setMaxStandbyStreamingDelay(ms: number): Promise<void>;
  /** The standby's cumulative recovery-conflict counters for the database. */
  conflicts(): Promise<StandbyConflicts>;
  /**
   * Arms a lock conflict that cancels the next plain read of `table` on the standby with 40001,
   * outside any transaction. See {@link LockConflict}.
   */
  armLockConflict(table: string): Promise<LockConflict>;
};

export type StandbyConflicts = {
  lock: number;
  snapshot: number;
  bufferpin: number;
  deadlock: number;
};

/**
 * How it works: a SELECT's planner locks the table, then each of its indexes in OID order. The
 * primary holds a NEW index of `table` in a prepared REINDEX, so replay holds that index and a
 * standby read blocks on it while already holding the table's older indexes. `fire()` then
 * reindexes an older index on the primary; replaying that lock conflicts with the blocked read,
 * which is cancelled. A read that starts again blocks on the new index until `release()`.
 */
export type LockConflict = {
  /** Resolve once a standby read is blocked on the armed lock. */
  waitForBlockedRead(timeoutMs?: number): Promise<void>;
  /** Replay the conflicting lock, cancelling the blocked read. */
  fire(): Promise<void>;
  /** Commit the armed lock so blocked and later reads proceed. Idempotent. */
  release(): Promise<void>;
};

// Reserved application_name for the harness's own connections, so a blocked-read probe never
// counts them.
const ADMIN_APPLICATION_NAME = "trigger-hot-standby-admin";
const IMAGE = "docker.io/postgres:17";
const PRIMARY_ALIAS = "hot-standby-primary";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, application_name: ADMIN_APPLICATION_NAME });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function poll(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(pollMs);
  }
  throw new Error(`hotStandby: timed out after ${timeoutMs}ms waiting for ${what}`);
}

export async function startHotStandby(
  network: StartedNetwork
): Promise<{ hotStandby: HotStandby; close(): Promise<void> }> {
  const primary = await withCiResourceLimits(new PostgreSqlContainer(IMAGE))
    .withNetwork(network)
    .withNetworkAliases(PRIMARY_ALIAS)
    .withDatabase("runops")
    .withTmpFs({ "/var/lib/postgresql/data": "rw" })
    .withCommand([
      "-c",
      "listen_addresses=*",
      "-c",
      "wal_level=replica",
      "-c",
      "max_wal_senders=5",
      "-c",
      "wal_keep_size=64MB",
      "-c",
      "max_prepared_transactions=10",
      "-c",
      "fsync=off",
    ])
    .start();

  const stopAll: Array<() => Promise<unknown>> = [() => primary.stop()];
  const close = async () => {
    for (const stop of stopAll.reverse()) {
      await stop().catch(() => {});
    }
  };

  try {
    // The image's pg_hba.conf does not admit replication connections; let the standby in.
    await primary.exec([
      "bash",
      "-c",
      'echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"',
    ]);
    const primaryUrl = primary.getConnectionUri();
    await withClient(primaryUrl, (c) => c.query("SELECT pg_reload_conf()"));
    await runSql(primaryUrl, await getRunOpsSchemaSql());

    const user = primary.getUsername();
    const password = primary.getPassword();

    // Base-backup the primary, then run as a hot standby. max_standby_streaming_delay is set with
    // ALTER SYSTEM below, because a command-line `-c` would override it.
    const standby = await withCiResourceLimits(new GenericContainer(IMAGE))
      .withNetwork(network)
      .withExposedPorts(5432)
      .withTmpFs({ "/var/lib/postgresql/data": "rw" })
      .withEnvironment({ PGPASSWORD: password })
      .withEntrypoint(["bash", "-c"])
      .withCommand([
        [
          "set -e",
          "D=/var/lib/postgresql/data",
          "chown postgres $D && chmod 700 $D",
          `gosu postgres pg_basebackup -h ${PRIMARY_ALIAS} -U ${user} -D $D -R -X stream -c fast`,
          "exec gosu postgres postgres -D $D -c hot_standby=on -c hot_standby_feedback=off" +
            " -c max_prepared_transactions=10 -c deadlock_timeout=100ms",
        ].join("\n"),
      ])
      .withWaitStrategy(Wait.forLogMessage("ready to accept read-only connections"))
      .start();
    stopAll.push(() => standby.stop());

    const standbyUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${standby.getHost()}:${standby.getMappedPort(5432)}/${primary.getDatabase()}`;

    const primarySql = (statements: string | readonly string[]) =>
      withClient(primaryUrl, async (c) => {
        for (const sql of typeof statements === "string" ? [statements] : statements) {
          await c.query(sql);
        }
      });

    const standbyRows = <R extends Record<string, unknown>>(sql: string) =>
      withClient(standbyUrl, async (c) => (await c.query<R>(sql)).rows);

    const waitForReplay = async (timeoutMs = 10_000) => {
      const lsn = await withClient(
        primaryUrl,
        async (c) =>
          (await c.query<{ lsn: string }>("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0]?.lsn
      );
      if (!lsn) {
        throw new Error("hotStandby: the primary returned no WAL position");
      }
      await poll(
        `replay of ${lsn}`,
        async () => {
          const [row] = await standbyRows<{ caught_up: boolean }>(
            `SELECT pg_last_wal_replay_lsn() >= '${lsn}'::pg_lsn AS caught_up`
          );
          return row?.caught_up === true;
        },
        timeoutMs
      );
    };

    const waitForReplayBlockedOnPin = (timeoutMs = 10_000) =>
      poll(
        "replay to wait on a buffer pin",
        async () => {
          const [row] = await standbyRows<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE backend_type = 'startup' AND wait_event = 'BufferPin'`
          );
          return (row?.n ?? 0) > 0;
        },
        timeoutMs
      );

    const setMaxStandbyStreamingDelay = async (ms: number) => {
      await withClient(standbyUrl, async (c) => {
        await c.query(`ALTER SYSTEM SET max_standby_streaming_delay = ${Math.trunc(ms)}`);
        await c.query("SELECT pg_reload_conf()");
      });
      // The reload is asynchronous: wait until a fresh backend sees the new value (reported in ms).
      await poll(
        `max_standby_streaming_delay = ${ms}ms`,
        async () => {
          const [row] = await standbyRows<{ setting: string }>(
            "SELECT setting FROM pg_settings WHERE name = 'max_standby_streaming_delay'"
          );
          return Number(row?.setting) === Math.trunc(ms);
        },
        5_000
      );
    };

    const conflicts = async (): Promise<StandbyConflicts> => {
      const [row] = await standbyRows<Record<string, string>>(
        `SELECT confl_lock AS lock, confl_snapshot AS snapshot, confl_bufferpin AS bufferpin,
                confl_deadlock AS deadlock
           FROM pg_stat_database_conflicts WHERE datname = current_database()`
      );
      return {
        lock: Number(row?.lock ?? 0),
        snapshot: Number(row?.snapshot ?? 0),
        bufferpin: Number(row?.bufferpin ?? 0),
        deadlock: Number(row?.deadlock ?? 0),
      };
    };

    const armed = new Set<string>();
    stopAll.push(async () => {
      // Never leave a prepared transaction holding locks if a test failed mid-way.
      for (const gid of armed) {
        await primarySql(`COMMIT PREPARED '${gid}'`).catch(() => {});
      }
    });
    let armCount = 0;

    const armLockConflict = async (table: string): Promise<LockConflict> => {
      const gid = `hot_standby_lock_${++armCount}`;
      const blocker = `hot_standby_blocker_${armCount}`;
      const quotedTable = `"${table.replace(/"/g, '""')}"`;

      // The table's oldest index: a read holds it while it waits on the blocker.
      const [held] = await withClient(
        primaryUrl,
        async (c) =>
          (
            await c.query<{ name: string; column: string }>(
              `SELECT i.indexrelid::regclass::text AS name,
                      (SELECT quote_ident(attname) FROM pg_attribute
                        WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
                        ORDER BY attnum LIMIT 1) AS column
                 FROM pg_index i WHERE i.indrelid = $1::regclass ORDER BY i.indexrelid LIMIT 1`,
              [quotedTable]
            )
          ).rows
      );
      if (!held) {
        throw new Error(`hotStandby.armLockConflict: ${table} has no index to hold`);
      }

      await primarySql(`CREATE INDEX "${blocker}" ON ${quotedTable} (${held.column})`);
      await primarySql(["BEGIN", `REINDEX INDEX "${blocker}"`, `PREPARE TRANSACTION '${gid}'`]);
      armed.add(gid);
      await waitForReplay();

      let releasing: Promise<void> | undefined;
      return {
        waitForBlockedRead: (timeoutMs = 5_000) =>
          poll(
            `a standby read blocked on ${blocker}`,
            async () => {
              const [row] = await standbyRows<{ n: number }>(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE wait_event_type = 'Lock' AND backend_type = 'client backend'
                    AND application_name <> '${ADMIN_APPLICATION_NAME}'`
              );
              return (row?.n ?? 0) > 0;
            },
            timeoutMs
          ),
        fire: () => primarySql(`REINDEX INDEX ${held.name}`),
        // Commit only: dropping the blocker index would replay an AccessExclusive lock on the
        // table and cancel a read that is still running.
        release: () =>
          (releasing ??= (async () => {
            await primarySql(`COMMIT PREPARED '${gid}'`);
            armed.delete(gid);
            await waitForReplay();
          })()),
      };
    };

    await setMaxStandbyStreamingDelay(0);

    return {
      close,
      hotStandby: {
        primaryUrl,
        standbyUrl,
        primarySql,
        waitForReplay,
        waitForReplayBlockedOnPin,
        setMaxStandbyStreamingDelay,
        conflicts,
        armLockConflict,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
