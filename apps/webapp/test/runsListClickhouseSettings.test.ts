import { ClickHouse } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";

vi.setConfig({ testTimeout: 60_000 });

describe("runs-list ClickHouse protection settings", () => {
  clickhouseTest(
    "server-side max_execution_time kills a slow read, and readonly=2 does not block the caps",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-list-settings-test",
        requestTimeoutMs: 30_000,
        clickhouseSettings: {
          max_execution_time: 1,
          timeout_before_checking_execution_speed: 0,
          max_threads: 2,
          readonly: "2",
        },
      });

      const slow = clickhouse.reader.query({
        name: "slow-read",
        query: "SELECT sum(number) AS total FROM numbers(1000000000000)",
        schema: z.object({ total: z.number() }),
      });
      const [slowError] = await slow({});

      expect(slowError).not.toBeNull();
      expect(slowError?.message.toLowerCase()).toMatch(/timeout|exceeded/);

      const fast = clickhouse.reader.query({
        name: "fast-read",
        query: "SELECT 1 AS one",
        schema: z.object({ one: z.number() }),
      });
      const [fastError, rows] = await fast({});

      expect(fastError).toBeNull();
      expect(rows).toEqual([{ one: 1 }]);
    }
  );

  clickhouseTest(
    "readonly=2 rejects writes while permitting reads",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-list-readonly-test",
        clickhouseSettings: { readonly: "2" },
      });

      const write = clickhouse.reader.query({
        name: "write-under-readonly",
        query: "CREATE TABLE trigger_dev.runs_list_readonly_probe (id UInt8) ENGINE = Memory",
        schema: z.object({}),
      });
      const [writeError] = await write({});

      expect(writeError).not.toBeNull();
      expect(writeError?.message.toLowerCase()).toMatch(/readonly|read-only|read only/);
    }
  );
});
