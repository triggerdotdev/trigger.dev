import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { z } from "zod";
import type { ClickHouseSettings } from "@clickhouse/client";
import type { ClickhouseClient } from "./client/client.js";
import type { ClickhouseReader } from "./client/types.js";
import { ClickHouse } from "./index.js";

const settingsSchema = z.object({ max_execution_time: z.string(), readonly: z.string() });

async function readSettings(client: ClickhouseReader, settings?: ClickHouseSettings) {
  const query = client.query({
    name: "read-effective-settings",
    query: `SELECT toString(getSetting('max_execution_time')) AS max_execution_time,
      toString(getSetting('readonly')) AS readonly`,
    schema: settingsSchema,
    settings,
  });

  const [error, rows] = await query({});
  if (error) throw error;
  return rows[0];
}

describe("reader-only settings", () => {
  clickhouseTest("apply to the reader and not the writer", async ({ clickhouseContainer }) => {
    const url = clickhouseContainer.getConnectionUrl();
    const ch = new ClickHouse({
      writerUrl: url,
      readerUrl: url,
      readerClickhouseSettings: { max_execution_time: 30, readonly: "2" },
    });

    expect(await readSettings(ch.reader)).toEqual({ max_execution_time: "30", readonly: "2" });
    expect(await readSettings(ch.writer as ClickhouseClient)).toEqual({
      max_execution_time: "0",
      readonly: "0",
    });

    await ch.close();
  });

  clickhouseTest("can be overridden per query", async ({ clickhouseContainer }) => {
    const url = clickhouseContainer.getConnectionUrl();
    const ch = new ClickHouse({
      writerUrl: url,
      readerUrl: url,
      readerClickhouseSettings: { max_execution_time: 30, readonly: "2" },
    });

    expect(await readSettings(ch.reader, { max_execution_time: 300 })).toEqual({
      max_execution_time: "300",
      readonly: "2",
    });

    await ch.close();
  });
});
