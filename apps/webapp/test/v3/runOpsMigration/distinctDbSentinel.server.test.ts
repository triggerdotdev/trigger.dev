import { heteroPostgresTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { probeDistinctDatabases } from "~/v3/runOpsMigration/distinctDbSentinel.server";

// Spinning up two separate postgres clusters and probing each can exceed the 5s default.
vi.setConfig({ testTimeout: 60_000 });

function urlWithDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("probeDistinctDatabases", () => {
  heteroPostgresTest(
    "reports distinct for two separate physical clusters",
    async ({ uri14, uri17 }) => {
      const result = await probeDistinctDatabases(uri14, uri17);
      expect(result).toEqual({ distinct: true });
    }
  );

  heteroPostgresTest(
    "reports NOT distinct, citing the same physical database, when both URLs point at it",
    async ({ uri14 }) => {
      const result = await probeDistinctDatabases(uri14, uri14);
      expect(result.distinct).toBe(false);
      if (result.distinct === false) {
        expect(result.reason).toMatch(/same physical database/i);
      }
    }
  );

  heteroPostgresTest(
    "reports distinct for two databases in the SAME cluster",
    async ({ postgresContainer14, uri14 }) => {
      const otherDb = `sentinel_other_${Date.now()}`;
      const admin = new PrismaClient({
        datasources: {
          db: { url: urlWithDatabase(postgresContainer14.getConnectionUri(), "postgres") },
        },
      });
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${otherDb}"`);
      } finally {
        await admin.$disconnect();
      }

      const otherUrl = urlWithDatabase(uri14, otherDb);
      const result = await probeDistinctDatabases(uri14, otherUrl);
      expect(result).toEqual({ distinct: true });
    }
  );

  heteroPostgresTest(
    "fails closed to NOT distinct when a probe cannot reach a database",
    async ({ uri14 }) => {
      const unreachable = "postgresql://nobody:nobody@127.0.0.1:1/does_not_exist";
      const result = await probeDistinctDatabases(uri14, unreachable);
      expect(result.distinct).toBe(false);
    }
  );
});
