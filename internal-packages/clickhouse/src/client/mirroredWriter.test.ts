import { createClient } from "@clickhouse/client";
import {
  ClickHouseContainer,
  clickhouseTest,
  withCiResourceLimits,
} from "@internal/testcontainers";
import { setTimeout } from "timers/promises";
import { z } from "zod";
import { ClickHouse } from "../index.js";

const smokeRow = z.object({ message: z.string(), number: z.number() });

async function readSmokeRows(url: string) {
  const client = createClient({ url });
  try {
    const result = await client.query({
      query: "SELECT message, number FROM trigger_dev.smoke_test ORDER BY number",
      format: "JSONEachRow",
    });
    return await result.json<{ message: string; number: number }>();
  } finally {
    await client.close();
  }
}

describe("ClickHouse with a mirror URL", () => {
  /**
   * Catches: a mirrored facade that only writes to the primary or builds the mirror client against
   * the primary URL, and one that copies a batch to the mirror even though the primary rejected it,
   * so caller retries would leave the mirror with duplicates.
   */
  clickhouseTest(
    "an insert lands in the mirror only after the primary accepts it",
    async ({ clickhouseContainer }) => {
      const mirrorContainer = await withCiResourceLimits(new ClickHouseContainer()).start();
      try {
        const mirrorUrl = mirrorContainer.getConnectionUrl();
        const mirrorAdmin = createClient({ url: mirrorUrl });
        await mirrorAdmin.command({ query: "CREATE DATABASE IF NOT EXISTS trigger_dev" });
        await mirrorAdmin.command({
          query:
            "CREATE TABLE trigger_dev.smoke_test (id UUID DEFAULT generateUUIDv4(), timestamp DateTime64(3) DEFAULT now64(3), message String, number UInt32) ENGINE = MergeTree() ORDER BY (timestamp, id)",
        });
        await mirrorAdmin.close();

        const clickhouse = new ClickHouse({
          name: "mirrored",
          url: clickhouseContainer.getConnectionUrl(),
          mirrorUrl,
          logLevel: "error",
        });
        const insert = clickhouse.writer.insert({
          name: "mirror-smoke",
          table: "trigger_dev.smoke_test",
          schema: smokeRow,
        });

        const [error, result] = await insert([{ message: "hello", number: 1 }]);
        expect(error).toBeNull();
        expect(result?.executed).toBe(true);

        expect(await readSmokeRows(clickhouseContainer.getConnectionUrl())).toEqual([
          { message: "hello", number: 1 },
        ]);
        await vi.waitFor(
          async () => {
            expect(await readSmokeRows(mirrorUrl)).toEqual([{ message: "hello", number: 1 }]);
          },
          { timeout: 5_000 }
        );
        await clickhouse.close();

        const deadPrimary = new ClickHouse({
          name: "dead-primary",
          url: "http://test:test@127.0.0.1:1/test",
          mirrorUrl,
          logLevel: "error",
        });
        const [deadError] = await deadPrimary.writer.insert({
          name: "mirror-smoke",
          table: "trigger_dev.smoke_test",
          schema: smokeRow,
        })([{ message: "rejected", number: 3 }]);
        expect(deadError).not.toBeNull();
        await setTimeout(500);
        expect(await readSmokeRows(mirrorUrl)).toEqual([{ message: "hello", number: 1 }]);
        await deadPrimary.close();
      } finally {
        await mirrorContainer.stop({ timeout: 0 });
      }
    }
  );

  /** Catches: a mirrored writer that awaits or surfaces the mirror write, turning a dead mirror into primary insert failures and stalled flushes. */
  clickhouseTest(
    "an unreachable mirror does not fail or delay the primary insert",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        name: "mirrored",
        url: clickhouseContainer.getConnectionUrl(),
        mirrorUrl: "http://test:test@127.0.0.1:1/test",
        logLevel: "error",
      });
      const insert = clickhouse.writer.insert({
        name: "mirror-smoke",
        table: "trigger_dev.smoke_test",
        schema: smokeRow,
      });

      const startedAt = Date.now();
      const [error, result] = await insert([{ message: "hello", number: 2 }]);
      expect(error).toBeNull();
      expect(result?.executed).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      expect(await readSmokeRows(clickhouseContainer.getConnectionUrl())).toEqual([
        { message: "hello", number: 2 },
      ]);

      await clickhouse.close();
    }
  );
});
