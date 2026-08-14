import { clickhouseTest } from "@internal/testcontainers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ClickHouse } from "./index.js";

const ORG = "org_logs_search";
const PROJECT = "project_logs_search";
const ENVIRONMENT = "env_logs_search";
const LIMITS = {
  maxExecutionTimeSeconds: 30,
  maxRowsToRead: 1_000_000,
  maxMemoryUsage: 500_000_000,
  maxThreads: 1,
};

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function event(now: Date, overrides: Record<string, unknown> = {}) {
  const start = clickhouseDate(now);
  return {
    environment_id: ENVIRONMENT,
    organization_id: ORG,
    project_id: PROJECT,
    task_identifier: "search-task",
    run_id: "run_logs_search",
    start_time: start,
    duration: "1000000",
    trace_id: "trace_logs_search",
    span_id: `span_${randomUUID()}`,
    parent_span_id: "",
    message: "TypeError: Zahlungsübersicht failed, retrying /api/orders/42",
    kind: "LOG_ERROR",
    status: "ERROR",
    attributes: {
      request_id: "req_123",
      status_code: 500,
      retryable: true,
      error: { message: "Payment failed, retrying" },
    },
    metadata: "{}",
    expires_at: clickhouseDate(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)),
    inserted_at: start,
    ...overrides,
  };
}

async function project(ch: ClickHouse, start: Date, end: Date) {
  const [error, result] = await ch.taskEventsSearch.projectV2Window({ start, end }, LIMITS);
  expect(error).toBeNull();
  expect(result?.query_id).toEqual(expect.any(String));
  return result!;
}

function searchRows(ch: ClickHouse) {
  const builder = ch.taskEventsSearch.logsListQueryBuilder("v2");
  builder.where("organization_id = {organizationId: String}", { organizationId: ORG });
  builder.orderBy("triggered_timestamp DESC, trace_id DESC, span_id DESC");
  builder.limit(50);
  return builder.execute();
}

describe("task events search v2", () => {
  clickhouseTest(
    "projects bounded normalized text outside the source insert path",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const now = new Date("2026-08-14T10:10:30.000Z");
      const start = new Date(now.getTime() - 30_000);
      const end = new Date(now.getTime() + 30_000);
      const [insertError] = await ch.taskEventsV2.insert([event(now)]);
      expect(insertError).toBeNull();

      const [beforeError, beforeRows] = await searchRows(ch);
      expect(beforeError).toBeNull();
      expect(beforeRows).toHaveLength(0);

      const schemaQuery = ch.reader.query({
        name: "read-search-v2-schema",
        query: `SELECT name, type FROM system.data_skipping_indices
          WHERE database = 'trigger_dev' AND table = 'task_events_v2'
            AND name = 'idx_inserted_at_projector'`,
        schema: z.object({ name: z.string(), type: z.string() }),
      });
      const [schemaError, indexes] = await schemaQuery({});
      expect(schemaError).toBeNull();
      expect(indexes).toEqual([{ name: "idx_inserted_at_projector", type: "minmax" }]);

      const tableQuery = ch.reader.query({
        name: "read-search-v2-table-engine",
        query: `SELECT name, engine FROM system.tables
          WHERE database = 'trigger_dev'
            AND name IN (
              'task_events_search_mv_v2',
              'task_events_search_v2',
              'task_events_search_v2_insert_triggered'
            )
          ORDER BY name`,
        schema: z.object({ name: z.string(), engine: z.string() }),
      });
      const [tableError, tables] = await tableQuery({});
      expect(tableError).toBeNull();
      expect(tables).toEqual([
        { name: "task_events_search_v2", engine: "ReplacingMergeTree" },
        { name: "task_events_search_v2_insert_triggered", engine: "MergeTree" },
      ]);

      const firstProjection = await project(ch, start, end);
      const retryProjection = await project(ch, start, end);
      expect(Number(firstProjection.summary?.written_rows)).toBe(1);
      expect(Number(retryProjection.summary?.written_rows)).toBe(1);

      const [readError, rows] = await searchRows(ch);
      expect(readError).toBeNull();
      expect(rows).toHaveLength(1);
      const rawQuery = ch.reader.query({
        name: "count-raw-search-v2-fixture",
        query: `SELECT count() AS count FROM trigger_dev.task_events_search_v2
          WHERE organization_id = {organizationId: String}`,
        params: z.object({ organizationId: z.string() }),
        schema: z.object({ count: z.number() }),
      });
      let [rawError, rawRows] = await rawQuery({ organizationId: ORG });
      expect(rawError).toBeNull();
      expect(rawRows?.[0].count).toBe(2);

      const optimize = ch.writer.command({
        name: "merge-search-v2-retry-fixture",
        query: "OPTIMIZE TABLE trigger_dev.task_events_search_v2 FINAL",
      });
      const [optimizeError] = await optimize({});
      expect(optimizeError).toBeNull();
      [rawError, rawRows] = await rawQuery({ organizationId: ORG });
      expect(rawError).toBeNull();
      expect(rawRows?.[0].count).toBe(1);

      expect(rows?.[0].message.toLowerCase()).toContain(
        "typeerror: zahlungsübersicht failed, retrying /api/orders/42"
      );
      expect(rows?.[0].error_message).toBe("Payment failed, retrying");

      const searchDataQuery = ch.reader.query({
        name: "read-search-v2-indexed-data",
        query: `SELECT search_text, error_message
          FROM trigger_dev.task_events_search_v2
          WHERE organization_id = {organizationId: String}
          LIMIT 1 BY projection_fingerprint`,
        params: z.object({ organizationId: z.string() }),
        schema: z.object({ search_text: z.string(), error_message: z.string() }),
      });
      const [searchDataError, searchData] = await searchDataQuery({ organizationId: ORG });
      expect(searchDataError).toBeNull();
      expect(searchData).toHaveLength(1);
      expect(searchData?.[0].search_text).toContain(
        "typeerror: zahlungsübersicht failed retrying /api/orders/42"
      );
      expect(searchData?.[0].search_text).toContain("status_code :500");
      expect(searchData?.[0].search_text).toContain("retryable :true");

      await ch.close();
    }
  );

  clickhouseTest(
    "uses half-open windows and deterministically clamps future timestamps",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "test" });
      const boundary = new Date("2026-08-14T11:01:00.000Z");
      const first = new Date(boundary.getTime() - 60_000);
      const second = boundary;
      const end = new Date(boundary.getTime() + 60_000);
      const [insertError] = await ch.taskEventsV2.insert([
        event(first, {
          span_id: "span_first",
          duration: "3153600000000000000",
          attributes: { prefix: "kept-token", payload: "x".repeat(100_000) },
        }),
        event(second, { span_id: "span_second" }),
      ]);
      expect(insertError).toBeNull();

      await project(ch, first, boundary);
      let [readError, rows] = await searchRows(ch);
      expect(readError).toBeNull();
      expect(rows).toHaveLength(1);
      const lengthQuery = ch.reader.query({
        name: "read-search-v2-length",
        query: `SELECT length(search_text) AS search_length
          FROM trigger_dev.task_events_search_v2
          WHERE organization_id = {organizationId: String}
          LIMIT 1 BY projection_fingerprint`,
        params: z.object({ organizationId: z.string() }),
        schema: z.object({ search_length: z.number() }),
      });
      const [lengthError, lengths] = await lengthQuery({ organizationId: ORG });
      expect(lengthError).toBeNull();
      expect(lengths?.[0].search_length).toBeLessThanOrEqual(8192);
      expect(rows?.[0].triggered_timestamp).toBeDefined();
      expect(new Date(`${rows?.[0].triggered_timestamp}Z`).getTime()).toBeLessThanOrEqual(
        boundary.getTime() + 5 * 60_000
      );

      await project(ch, boundary, end);
      [readError, rows] = await searchRows(ch);
      expect(readError).toBeNull();
      expect(rows).toHaveLength(2);

      await ch.close();
    }
  );
});
