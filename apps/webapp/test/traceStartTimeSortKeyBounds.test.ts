import {
  buildTraceStartTimeSortKeyPredicate,
  ClickHouse,
  type TaskEventV2Input,
} from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { convertDateToNanoseconds } from "~/v3/eventRepository/common.server";

vi.setConfig({ testTimeout: 120_000 });

const TRACE_ID = "trace_start_time_end_test";
const ENV_ID = "env_start_time_end_test";
const START = new Date("2026-09-01T10:00:00.000Z");
// Sub-second end, so a rounding mistake in the sort-key bound would drop rows.
const END = new Date("2026-09-01T10:00:00.500Z");
// The trace scope adds 60s to the end.
const SCOPE_END_SECOND = "2026-09-01 10:01:00";
const NOISE_ROWS = 30_000;
// query_log stores the SQL with params inlined as _CAST(value, 'Int64').
const SORT_KEY_START =
  /toUnixTimestamp\(start_time\) >= intDiv\(_CAST\(\d+, 'Int64'\), 1000000000\)/;
const SORT_KEY_END = /toUnixTimestamp\(start_time\) <= intDiv\(_CAST\(\d+, 'Int64'\), 1000000000\)/;

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function row(
  traceId: string,
  spanId: string,
  message: string,
  startTime: string,
  insertedAt = START
): TaskEventV2Input {
  return {
    environment_id: ENV_ID,
    organization_id: "org_start_time_end_test",
    project_id: "project_start_time_end_test",
    task_identifier: "start-time-end-task",
    run_id: "run_start_time_end_test",
    start_time: startTime,
    inserted_at: convertDateToClickhouseDateTime(insertedAt),
    duration: "1000000",
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: "",
    message,
    kind: "SPAN",
    status: "OK",
    attributes: {},
    metadata: "{}",
    expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
  };
}

async function shutdownRepository(repository: ClickhouseEventRepository): Promise<void> {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

function setup(url: string) {
  const clickhouse = new ClickHouse({ url, name: "test" });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    insertStrategy: "insert",
  });
  return { clickhouse, repository };
}

async function readMessages(repository: ClickhouseEventRepository, end: Date | undefined) {
  const chunk = await repository.getTraceChunk(
    "taskEventPartitioned",
    ENV_ID,
    TRACE_ID,
    START,
    end,
    undefined,
    {}
  );
  return (chunk?.events ?? []).map((e) => e.message).sort();
}

describe("trace reads with a start_time end", () => {
  clickhouseTest("returns the same rows around the end second", async ({ clickhouseContainer }) => {
    const { clickhouse, repository } = setup(clickhouseContainer.getConnectionUrl());

    try {
      const [insertError] = await clickhouse.taskEventsV2.insert([
        row(TRACE_ID, "a", "second-start", `${SCOPE_END_SECOND}.000000000`),
        row(TRACE_ID, "b", "before-end", `${SCOPE_END_SECOND}.100000000`),
        row(TRACE_ID, "c", "at-end", `${SCOPE_END_SECOND}.500000000`),
        row(TRACE_ID, "d", "end-plus-1ns", `${SCOPE_END_SECOND}.500000001`),
        row(TRACE_ID, "e", "same-second-later", `${SCOPE_END_SECOND}.900000000`),
        row(TRACE_ID, "f", "next-second", "2026-09-01 10:01:01.000000000"),
      ]);
      expect(insertError).toBeNull();

      expect(await readMessages(repository, END)).toEqual(["at-end", "before-end", "second-start"]);
      expect(await readMessages(repository, undefined)).toEqual([
        "at-end",
        "before-end",
        "end-plus-1ns",
        "next-second",
        "same-second-later",
        "second-start",
      ]);
    } finally {
      await shutdownRepository(repository);
    }
  });

  clickhouseTest(
    "narrows the primary key with the sort-key bounds alone",
    async ({ clickhouseContainer }) => {
      const { clickhouse, repository } = setup(clickhouseContainer.getConnectionUrl());

      try {
        // Other traces in the same env, one per second before and after the run, so the
        // run's row sits mid-part with granules on both sides.
        const noise = Array.from({ length: NOISE_ROWS }, (_, i) =>
          row(
            `trace_noise_${i}`,
            `noise_${i}`,
            "noise",
            clickhouseDate(new Date(START.getTime() + (i - NOISE_ROWS / 2) * 1000))
          )
        );
        const [insertError] = await clickhouse.taskEventsV2.insert([
          row(TRACE_ID, "a", "span", clickhouseDate(START)),
          ...noise,
        ]);
        expect(insertError).toBeNull();

        // Some ClickHouse setups (prod) ignore the exact string bounds when choosing
        // granules, so check the sort-key clause without them.
        const { clause, params } = buildTraceStartTimeSortKeyPredicate({
          startNs: convertDateToNanoseconds(START).toString(),
          endNs: convertDateToNanoseconds(END).toString(),
        });
        const explain = clickhouse.reader.query({
          name: "explainSortKeyBounds",
          query: `EXPLAIN indexes = 1 SELECT span_id FROM trigger_dev.task_events_v2 WHERE environment_id = {environmentId: String} AND ${clause}`,
          params: z.any(),
          schema: z.object({ explain: z.string() }),
        });
        const [explainError, rows] = await explain({ ...params, environmentId: ENV_ID });
        expect(explainError).toBeNull();

        const lines = (rows ?? []).map((r) => r.explain.trim());
        const primaryKey = lines.indexOf("PrimaryKey");
        const granules = lines.slice(primaryKey).find((l) => l.startsWith("Granules:"));
        const [selected, total] = granules!.replace("Granules:", "").trim().split("/").map(Number);
        expect(total).toBeGreaterThan(2);
        expect(selected).toBe(1);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  clickhouseTest(
    "adds the sort-key bounds to trace chunk reads",
    async ({ clickhouseContainer }) => {
      const { clickhouse, repository } = setup(clickhouseContainer.getConnectionUrl());

      try {
        const [insertError] = await clickhouse.taskEventsV2.insert([
          row(TRACE_ID, "a", "span", clickhouseDate(START)),
        ]);
        expect(insertError).toBeNull();

        // The container is shared across tests, so only look at queries from here on.
        const serverNow = clickhouse.reader.query({
          name: "serverNowMicros",
          query: "SELECT toString(toUnixTimestamp64Micro(now64(6))) AS since",
          schema: z.object({ since: z.string() }),
        });
        const [nowError, nowRows] = await serverNow({});
        expect(nowError).toBeNull();
        const since = nowRows![0].since;

        // Completed run first, then live run, so query_log order identifies them.
        expect(await readMessages(repository, END)).toEqual(["span"]);
        expect(await readMessages(repository, undefined)).toEqual(["span"]);

        const flushLogs = clickhouse.writer.command({
          name: "flushLogs",
          query: "SYSTEM FLUSH LOGS",
        });
        const [flushError] = await flushLogs({});
        expect(flushError).toBeNull();

        const loggedQueries = clickhouse.reader.query({
          name: "traceChunkQueryLog",
          query: `SELECT query FROM system.query_log
            WHERE type = 'QueryFinish'
              AND toUnixTimestamp64Micro(event_time_microseconds) > {since: Int64}
              AND query LIKE 'SELECT%FROM trigger_dev.task_events_v2%'
            ORDER BY event_time_microseconds`,
          params: z.object({ since: z.string() }),
          schema: z.object({ query: z.string() }),
        });
        const [logError, rows] = await loggedQueries({ since });
        expect(logError).toBeNull();

        const queries = (rows ?? []).map((r) => r.query);
        expect(queries).toHaveLength(2);
        const [completed, live] = queries;

        expect(completed).toMatch(SORT_KEY_START);
        expect(completed).toMatch(SORT_KEY_END);
        expect(live).toMatch(SORT_KEY_START);
        expect(live).not.toMatch(SORT_KEY_END);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});
