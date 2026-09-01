import { describe, expect } from "vitest";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@trigger.dev/database";
import { postgresBlipTest } from "./index";

// A minimal infra retry, standing in for the shared read-retry util so this
// file can demonstrate the harness end-to-end on its own.
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 8): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, Math.min(50 * (attempt + 1), 250)));
    }
  }
  throw lastError;
}

// Production runs the pg driver adapter, so the client under test is adapter-backed.
async function adapterClient(connectionString: string) {
  const pool = new Pool({ connectionString });
  // A severed idle connection makes the pg Pool emit 'error'; swallow it so an
  // unhandled event can't crash the test worker before recovery is asserted.
  pool.on("error", () => {});
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  const dispose = async () => {
    try {
      await client.$disconnect();
    } finally {
      await pool.end();
    }
  };
  return { client, dispose };
}

async function createProbeTable(client: PrismaClient) {
  await client.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS blip_probe (id uuid PRIMARY KEY, tag text NOT NULL)`
  );
}

async function countTag(client: PrismaClient, tag: string): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM blip_probe WHERE tag = $1`,
    tag
  );
  return rows[0]?.n ?? 0;
}

describe("DbBlipController", () => {
  postgresBlipTest(
    "a pooled adapter client transparently survives an idle-connection drop",
    { timeout: 60_000 },
    async ({ postgresContainer, blip }) => {
      const { client, dispose } = await adapterClient(postgresContainer.getConnectionUri());
      try {
        await client.user.count(); // warm the pool
        const terminated = await blip.severIdle();
        expect(terminated).toBeGreaterThan(0);
        // The pool evicts the dead idle connection; the next read just works.
        await new Promise((r) => setTimeout(r, 200));
        const count = await client.user.count();
        expect(typeof count).toBe("number");
      } finally {
        await dispose();
      }
    }
  );

  postgresBlipTest(
    "severDuringNextStatement fails an in-flight statement",
    { timeout: 60_000 },
    async ({ postgresContainer, blip }) => {
      const { client, dispose } = await adapterClient(postgresContainer.getConnectionUri());
      try {
        const slow = client.$queryRawUnsafe(`SELECT pg_sleep(3)`);
        // PrismaPromise is lazy — form the assertion so the query actually starts.
        const rejected = expect(slow).rejects.toThrow();
        await blip.severDuringNextStatement({ queryContains: "pg_sleep" });
        await rejected;
      } finally {
        await dispose();
      }
    }
  );

  postgresBlipTest(
    "a read recovers after a mid-flight blip",
    { timeout: 60_000 },
    async ({ postgresContainer, blip }) => {
      const { client, dispose } = await adapterClient(postgresContainer.getConnectionUri());
      try {
        const severed = client.$queryRawUnsafe(`SELECT pg_sleep(3)`).catch(() => undefined);
        await blip.severDuringNextStatement({ queryContains: "pg_sleep" });
        await severed;
        const count = await withRetry(() => client.user.count());
        expect(typeof count).toBe("number");
      } finally {
        await dispose();
      }
    }
  );

  postgresBlipTest(
    "a non-idempotent write double-applies on retry after a post-commit blip; the idempotent form does not",
    { timeout: 60_000 },
    async ({ postgresContainer, blip }) => {
      const { client, dispose } = await adapterClient(postgresContainer.getConnectionUri());
      try {
        await createProbeTable(client);

        // Model the dangerous case: the write commits, then a later statement in
        // the same op is severed mid-flight (ack lost), and the caller retries.
        let nonIdempotentAttempts = 0;
        const nonIdempotentWrite = async () => {
          nonIdempotentAttempts++;
          await client.$executeRawUnsafe(
            `INSERT INTO blip_probe (id, tag) VALUES (gen_random_uuid(), 'non-idempotent')`
          );
          if (nonIdempotentAttempts === 1) {
            await client.$queryRawUnsafe(`SELECT pg_sleep(3)`); // severed → throws after the commit
          }
        };
        const nonIdempotentDone = withRetry(nonIdempotentWrite);
        await blip.severDuringNextStatement({ queryContains: "pg_sleep" });
        await nonIdempotentDone;
        expect(await countTag(client, "non-idempotent")).toBe(2); // the hazard, proven

        // The idempotent form: a fixed id + ON CONFLICT makes the replay a no-op.
        let idempotentAttempts = 0;
        const idempotentWrite = async () => {
          idempotentAttempts++;
          await client.$executeRawUnsafe(
            `INSERT INTO blip_probe (id, tag)
           VALUES ('00000000-0000-0000-0000-000000000001', 'idempotent')
           ON CONFLICT (id) DO NOTHING`
          );
          if (idempotentAttempts === 1) {
            await client.$queryRawUnsafe(`SELECT pg_sleep(3)`);
          }
        };
        const idempotentDone = withRetry(idempotentWrite);
        await blip.severDuringNextStatement({ queryContains: "pg_sleep" });
        await idempotentDone;
        expect(await countTag(client, "idempotent")).toBe(1); // exactly once despite retry
      } finally {
        await dispose();
      }
    }
  );

  // Regression: queryContains must match as literal text, not as an ILIKE pattern.
  // The active query contains "fooXbar"; under ILIKE the pattern "foo_bar" (with the
  // wildcard `_`) would wrongly match and terminate it. The literal matcher must not,
  // so the sever times out instead of killing the wrong statement.
  postgresBlipTest(
    "severDuringNextStatement matches queryContains literally, not as an ILIKE pattern",
    { timeout: 60_000 },
    async ({ postgresContainer, blip }) => {
      const { client, dispose } = await adapterClient(postgresContainer.getConnectionUri());
      const slow = client
        .$queryRawUnsafe(`SELECT pg_sleep(3) /* marker fooXbar */`)
        .catch(() => undefined);
      try {
        await expect(
          blip.severDuringNextStatement({ queryContains: "foo_bar", timeoutMs: 1000, pollMs: 25 })
        ).rejects.toThrow(/no active statement/i);
      } finally {
        await dispose();
        await slow;
      }
    }
  );
});
