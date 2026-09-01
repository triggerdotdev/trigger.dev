import { Client } from "pg";

/**
 * Simulates a connection blip against a test Postgres (via a separate admin
 * connection that terminates backends), so a vertical can prove its DB code
 * survives a disconnect. Reproduces the mid-statement / stale-connection
 * signatures (P1017, "Connection terminated unexpectedly").
 */
export type DbBlipController = {
  /** Terminate every idle client backend except this harness's own, so the
   * next operation hits a dead connection. Returns the number terminated. */
  severIdle(): Promise<number>;

  /** Poll for an active client statement (optionally matching `queryContains`
   * literally), then terminate it mid-flight. Rejects if none appears within
   * `timeoutMs`. Terminating by pid isn't atomic with statement completion, so
   * target a statement with a real execution window (e.g. `pg_sleep`) — a query
   * that finishes first leaves its connection idle and it is closed anyway. */
  severDuringNextStatement(opts?: {
    queryContains?: string;
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<void>;
};

/** A {@link DbBlipController} plus the teardown for its admin connection. */
export type DbBlipHandle = DbBlipController & { close(): Promise<void> };

// Reserved application_name for the harness's control connections. The severs
// exclude every connection using it (by name, plus their own pid), so multiple
// controllers on one database can't kill each other's admin. A client-under-test
// must not use this name.
const ADMIN_APPLICATION_NAME = "trigger-db-blip-admin";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Opens an isolated admin connection and returns a handle that can sever the
 * other connections on that database. `close()` in teardown. */
export async function createDbBlipController(connectionUri: string): Promise<DbBlipHandle> {
  // Raw pg (not Prisma): the control connection must be one identifiable backend we can exclude from the sever, independent of the client under test.
  const admin = new Client({
    connectionString: connectionUri,
    application_name: ADMIN_APPLICATION_NAME,
  });
  await admin.connect();
  // Swallow async connection errors so a consumer that severs a DB the admin
  // isn't excluded from (or drops it while open) can't crash the test worker.
  admin.on("error", () => {});

  async function severIdle(): Promise<number> {
    const result = await admin.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
          AND application_name IS DISTINCT FROM $1
          AND state = 'idle'`,
      [ADMIN_APPLICATION_NAME]
    );
    // Count only backends that were actually terminated (a backend that exits
    // between selection and signalling returns false).
    return result.rows.filter((row) => row.terminated === true).length;
  }

  async function severDuringNextStatement(opts?: {
    queryContains?: string;
    timeoutMs?: number;
    pollMs?: number;
  }): Promise<void> {
    const queryContains = opts?.queryContains ?? null;
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const pollMs = opts?.pollMs ?? 25;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Select and terminate in one statement so the backend can't go idle
      // between picking it and killing it; return only when it was terminated.
      const terminated = await admin.query<{ ok: boolean }>(
        `SELECT pg_terminate_backend(pid) AS ok
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND pid <> pg_backend_pid()
            AND backend_type = 'client backend'
            AND application_name IS DISTINCT FROM $1
            AND ($2::text IS NULL OR strpos(lower(query), lower($2)) > 0)
          LIMIT 1`,
        [ADMIN_APPLICATION_NAME, queryContains]
      );

      if (terminated.rows[0]?.ok === true) {
        return;
      }

      await sleep(pollMs);
    }

    throw new Error(
      `severDuringNextStatement: no active statement${
        queryContains ? ` matching ${JSON.stringify(queryContains)}` : ""
      } appeared within ${timeoutMs}ms`
    );
  }

  return { severIdle, severDuringNextStatement, close: () => admin.end() };
}
