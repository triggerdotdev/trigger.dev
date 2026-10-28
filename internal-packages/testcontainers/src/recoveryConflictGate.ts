import { randomBytes } from "node:crypto";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, Pool } from "pg";

/** A gate installed by {@link installRecoveryConflictGate}. */
export type RecoveryConflictGate = {
  /** Connection URI for the gated reader role on the same database. */
  readerUri: string;
  /** Fail the next `count` gated reads with this error, and reset the evaluation counter. */
  failNext(count: number, error?: RecoveryConflictGateError): Promise<void>;
  /** Number of gate evaluations since the last {@link failNext} (failed and passed). */
  evaluations(): Promise<number>;
  /** Drops the reader role. Disconnect clients using {@link readerUri} first. */
  close(): Promise<void>;
};

export type RecoveryConflictGateError = {
  sqlstate: string;
  message: string;
  detail?: string;
};

/** What Postgres reports when replay of a page cleanup waits on a standby query's buffer pin. */
export const BUFFER_DEADLOCK_RECOVERY_CONFLICT: RecoveryConflictGateError = {
  sqlstate: "40P01",
  message: "canceling statement due to conflict with recovery",
  detail: "User transaction caused buffer deadlock with recovery.",
};

/** What Postgres reports when replay needs to remove row versions a standby query can still see. */
export const SNAPSHOT_RECOVERY_CONFLICT: RecoveryConflictGateError = {
  sqlstate: "40001",
  message: "canceling statement due to conflict with recovery",
  detail: "User query might have needed to see row versions that must be removed.",
};

/**
 * Makes reads of one table fail with a chosen SQLSTATE on a plain Postgres, so code that handles a
 * hot standby cancelling a read ("canceling statement due to conflict with recovery") can be tested
 * without running a real standby.
 *
 * It enables row-level security on the table with a SELECT policy that calls a plpgsql gate. The gate
 * RAISEs the configured SQLSTATE, message and detail for its first N evaluations, then lets reads
 * through. The policy applies only to a dedicated non-owner login role; connect the client under test
 * with {@link RecoveryConflictGate.readerUri}. The owner (the fixture's URI) seeds and reads unimpeded.
 * The reader role is not made read-only: the gate's counter is a sequence, and nextval is refused in a
 * read-only transaction.
 *
 * The gate runs once per row the read evaluates, so seed exactly one row in the gated table when a
 * test counts attempts with {@link RecoveryConflictGate.evaluations}.
 */
export async function installRecoveryConflictGate(
  ownerUri: string,
  table: string
): Promise<RecoveryConflictGate> {
  // Roles are cluster-wide and test databases share a cluster, so each gate gets its own role.
  const role = `rc_reader_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  const quotedTable = `"${table.replace(/"/g, '""')}"`;

  const admin = new Client({ connectionString: ownerUri });
  await admin.connect();

  const dropRole = async () => {
    // The role outlives the test's cloned database, so drop it explicitly. DROP OWNED removes its
    // grants and its policy in this database first, which DROP ROLE requires.
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
  };

  let roleCreated = false;
  try {
    await admin.query(`
    CREATE SEQUENCE IF NOT EXISTS recovery_conflict_gate_evaluations;
    CREATE TABLE IF NOT EXISTS recovery_conflict_gate_config (
      id int PRIMARY KEY,
      fail_first bigint NOT NULL,
      sqlstate text NOT NULL,
      message text NOT NULL,
      detail text
    );
    INSERT INTO recovery_conflict_gate_config VALUES (1, 0, '40P01', 'unused', NULL)
      ON CONFLICT (id) DO NOTHING;

    -- SECURITY DEFINER so the reader role needs no rights on the sequence or config table. A
    -- sequence counts evaluations because nextval survives the statement the gate aborts.
    CREATE OR REPLACE FUNCTION recovery_conflict_gate() RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
    DECLARE
      cfg recovery_conflict_gate_config%ROWTYPE;
      evaluation bigint;
    BEGIN
      SELECT * INTO cfg FROM recovery_conflict_gate_config WHERE id = 1;
      evaluation := nextval('recovery_conflict_gate_evaluations');
      IF evaluation <= cfg.fail_first THEN
        IF cfg.detail IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = cfg.sqlstate, MESSAGE = cfg.message;
        END IF;
        RAISE EXCEPTION USING ERRCODE = cfg.sqlstate, MESSAGE = cfg.message, DETAIL = cfg.detail;
      END IF;
      RETURN true;
    END $$;
  `);

    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    roleCreated = true;
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await admin.query(`ALTER TABLE ${quotedTable} ENABLE ROW LEVEL SECURITY`);
    await admin.query(
      `CREATE POLICY recovery_conflict_gate_${role} ON ${quotedTable} FOR SELECT TO ${role}
       USING (recovery_conflict_gate())`
    );
  } catch (error) {
    // A failed install would otherwise leave the role behind and the admin connection open.
    try {
      if (roleCreated) await dropRole();
    } finally {
      await admin.end();
    }
    throw error;
  }

  const readerUrl = new URL(ownerUri);
  readerUrl.username = role;
  readerUrl.password = password;

  return {
    readerUri: readerUrl.toString(),
    async failNext(count, error = BUFFER_DEADLOCK_RECOVERY_CONFLICT) {
      await admin.query(
        `UPDATE recovery_conflict_gate_config
            SET fail_first = $1, sqlstate = $2, message = $3, detail = $4
          WHERE id = 1`,
        [count, error.sqlstate, error.message, error.detail ?? null]
      );
      await admin.query(`ALTER SEQUENCE recovery_conflict_gate_evaluations RESTART WITH 1`);
    },
    async evaluations() {
      const { rows } = await admin.query<{ last_value: string; is_called: boolean }>(
        `SELECT last_value, is_called FROM recovery_conflict_gate_evaluations`
      );
      const row = rows[0];
      return row?.is_called ? Number(row.last_value) : 0;
    },
    async close() {
      try {
        await dropRole();
      } finally {
        await admin.end();
      }
    },
  };
}

export type ReaderClientDriver = "engine" | "adapter";

/**
 * A run-ops Prisma client on `uri` (normally {@link RecoveryConflictGate.readerUri}) using the query
 * engine's own connection pool or the pg driver adapter, which surface database errors differently.
 * `disconnect()` also ends the adapter's pool.
 */
export function connectReaderClient(
  uri: string,
  driver: ReaderClientDriver
): { client: RunOpsPrismaClient; disconnect(): Promise<void> } {
  const pool = driver === "adapter" ? new Pool({ connectionString: uri }) : undefined;
  const client = pool
    ? new RunOpsPrismaClient({ adapter: new PrismaPg(pool) })
    : new RunOpsPrismaClient({ datasources: { db: { url: uri } } });
  return {
    client,
    async disconnect() {
      await client.$disconnect();
      await pool?.end();
    },
  };
}
