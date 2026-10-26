import { readFileSync } from "node:fs";
import path from "node:path";
import { postgresTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { Client } from "pg";
import { describe, expect, vi } from "vitest";
import { ensureAlertHistoryPartitions } from "~/v3/services/alerts/storage/alertPartitions.server";

vi.setConfig({ testTimeout: 120_000 });

const MIGRATION_SQL = readFileSync(
  path.resolve(
    __dirname,
    "../../../internal-packages/database/prisma/migrations/20261019120000_alerts_v1/migration.sql"
  ),
  "utf8"
);

const NOW = new Date("2030-06-30T00:00:00Z");

async function connect(uri: string): Promise<Client> {
  const client = new Client({ connectionString: uri });
  await client.connect();
  return client;
}

async function withAlertTables(uri: string, months: string[]): Promise<Client> {
  const client = await connect(uri);
  await client.query(
    `DROP TABLE IF EXISTS "Alert", "AlertEvent", "AlertDelivery", "AlertOccurrenceSeen" CASCADE`
  );
  await client.query(MIGRATION_SQL);
  for (const parent of ["AlertEvent", "AlertDelivery"]) {
    for (const month of months) {
      const lo = `${month.slice(0, 4)}-${month.slice(4)}-01T00:00:00Z`;
      await client.query(
        `CREATE TABLE "${parent}_p${month}" PARTITION OF "${parent}"
         FOR VALUES FROM ('${lo}') TO (('${lo}'::timestamptz + interval '1 month'))`
      );
    }
  }
  return client;
}

async function exists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT to_regclass($1)::text AS oid`, [`"${name}"`]);
  return rows[0]?.oid != null;
}

async function pendingDetaches(client: Client): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT c.relname::text AS name FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhdetachpending`
  );
  return rows.map((r) => r.name);
}

async function holdLock(uri: string, table: string): Promise<Client> {
  const holder = await connect(uri);
  await holder.query("BEGIN");
  await holder.query(`SELECT count(*) FROM "${table}"`);
  return holder;
}

function clientWithLimit(uri: string, limit: number): PrismaClient {
  const url = new URL(uri);
  url.searchParams.set("connection_limit", String(limit));
  url.searchParams.set("pool_timeout", "0");
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

describe("ensureAlertHistoryPartitions", () => {
  postgresTest(
    "never drops a partition whose bounds differ from its name",
    async ({ postgresContainer, prisma }) => {
      const client = await withAlertTables(postgresContainer.getConnectionUri(), []);
      try {
        await client.query(
          `CREATE TABLE "AlertEvent_p203003" PARTITION OF "AlertEvent"
           FOR VALUES FROM ('2030-05-01T00:00:00Z') TO ('2030-06-01T00:00:00Z')`
        );

        const result = await ensureAlertHistoryPartitions(prisma, { now: NOW });

        expect(result.dropped).not.toContain("AlertEvent_p203003");
        expect(result.deferred).toContainEqual({
          name: "AlertEvent_p203003",
          message: expect.stringMatching(/expected UTC bounds/),
        });
        expect(await exists(client, "AlertEvent_p203003")).toBe(true);
      } finally {
        await client.end();
      }
    }
  );

  postgresTest(
    "creates the lookahead and drops a month at the retention cutoff",
    async ({ postgresContainer, prisma }) => {
      const client = await withAlertTables(postgresContainer.getConnectionUri(), ["203003"]);
      try {
        const result = await ensureAlertHistoryPartitions(prisma, { now: NOW });

        expect(result.deferred).toEqual([]);
        expect(result.lookaheadMonths).toBe(2);
        for (const parent of ["AlertEvent", "AlertDelivery"]) {
          expect(result.created).toContain(`${parent}_p203008`);
          expect(result.dropped).toContain(`${parent}_p203003`);
          expect(await exists(client, `${parent}_p203003`)).toBe(false);
          expect(await exists(client, `${parent}_p203004`)).toBe(true);
          expect(await exists(client, `${parent}_p203009`)).toBe(false);
        }
        const { rows } = await client.query(
          `SELECT pg_get_expr(c.relpartbound, c.oid) =
             format('FOR VALUES FROM (%L) TO (%L)', '2030-08-01T00:00:00Z'::timestamptz, '2030-09-01T00:00:00Z'::timestamptz) AS ok
           FROM pg_class c WHERE c.oid = to_regclass('"AlertEvent_p203008"')`
        );
        expect(rows[0]?.ok).toBe(true);
      } finally {
        await client.end();
      }
    }
  );

  postgresTest(
    "finalizes a half-detached partition before dropping it",
    async ({ postgresContainer, prisma }) => {
      const uri = postgresContainer.getConnectionUri();
      const client = await withAlertTables(uri, ["203003"]);
      try {
        const holder = await holdLock(uri, "AlertEvent");
        await client.query(`SET statement_timeout = '1s'`);
        await expect(
          client.query(
            `ALTER TABLE "AlertEvent" DETACH PARTITION "AlertEvent_p203003" CONCURRENTLY`
          )
        ).rejects.toThrow();
        await client.query(`RESET statement_timeout`);
        await holder.query("COMMIT");
        await holder.end();
        expect(await pendingDetaches(client)).toEqual(["AlertEvent_p203003"]);

        const result = await ensureAlertHistoryPartitions(prisma, { now: NOW });

        expect(await pendingDetaches(client)).toEqual([]);
        expect(result.deferred).toEqual([]);
        expect(result.dropped).toContain("AlertEvent_p203003");
        expect(await exists(client, "AlertEvent_p203003")).toBe(false);
      } finally {
        await client.end();
      }
    }
  );

  postgresTest(
    "cancels a stuck detach on its own pool while the app pool is saturated",
    async ({ postgresContainer }) => {
      const uri = postgresContainer.getConnectionUri();
      const client = await withAlertTables(uri, [
        "203003",
        "203004",
        "203005",
        "203006",
        "203007",
        "203008",
      ]);
      const app = clientWithLimit(uri, 1);
      const ddl = clientWithLimit(uri, 2);
      await ddl.$queryRawUnsafe(`SELECT 1`);
      let release!: () => void;
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = app.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT count(*) FROM "AlertDelivery"`);
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 60_000 }
      );
      await isLocked;
      let stuck: string | undefined;
      try {
        try {
          const started = Date.now();
          const result = await Promise.race([
            ensureAlertHistoryPartitions(ddl, { now: NOW, deadline: started + 2_000 }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("maintenance did not return")), 8_000)
            ),
          ]);

          expect(Date.now() - started).toBeLessThan(2_000 + 5_000 + 500);
          expect(result.connectionStuck).toBe(true);
          stuck = result.deferred[result.deferred.length - 1]?.name;
          expect(stuck).toMatch(/^AlertDelivery_p/);
          const { rows } = await client.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE query LIKE '%alerts-partitions:%' AND state = 'active'
             AND pid <> pg_backend_pid()`
          );
          expect(rows[0]?.n).toBe(0);
        } finally {
          release();
          await holder;
          await app.$disconnect();
        }

        const next = await ensureAlertHistoryPartitions(ddl, { now: NOW });
        expect(next.connectionStuck).toBeUndefined();
        expect(next.deferred).toEqual([]);
        expect(next.dropped).toContain(stuck);
        expect(await exists(client, stuck!)).toBe(false);
        expect(await pendingDetaches(client)).toEqual([]);
      } finally {
        await ddl.$disconnect();
        await client.end();
      }
    }
  );
});
