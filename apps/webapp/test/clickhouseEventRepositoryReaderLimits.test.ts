import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";

vi.setConfig({ testTimeout: 60_000 });

const TRACE_ID = "trace_reader_limits";
const ENV_ID = "env_reader_limits";
const BASE = new Date("2026-09-01T10:00:00.000Z");

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

const EVENT: TaskEventV2Input = {
  environment_id: ENV_ID,
  organization_id: "org_reader_limits",
  project_id: "project_reader_limits",
  task_identifier: "limits-task",
  run_id: "run_reader_limits",
  start_time: clickhouseDate(BASE),
  duration: "1000000",
  trace_id: TRACE_ID,
  span_id: "root",
  parent_span_id: "",
  message: "root",
  kind: "SPAN",
  status: "OK",
  attributes: {},
  metadata: "{}",
  expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
};

async function setup(url: string) {
  const clickhouse = new ClickHouse({
    writerUrl: url,
    readerUrl: url,
    readerClickhouseSettings: { max_execution_time: 30 },
  });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    exportMaxExecutionTime: 300,
  });

  const [insertError] = await clickhouse.taskEventsV2.insert([EVENT]);
  if (insertError) throw insertError;

  return { clickhouse, repository };
}

async function shutdown(clickhouse: ClickHouse, repository: ClickhouseEventRepository) {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
  await clickhouse.close();
}

async function serverNow(url: string): Promise<string> {
  const inspector = new ClickHouse({ url, name: "inspector" });
  const [error, rows] = await inspector.reader.query({
    name: "read-server-now",
    query: "SELECT toString(now64(6)) AS now",
    schema: z.object({ now: z.string() }),
  })({});
  await inspector.close();
  if (error) throw error;

  return rows[0].now;
}

async function eventReadLimits(url: string, since: string): Promise<string[]> {
  const inspector = new ClickHouse({ url, name: "inspector" });
  const [flushError] = await inspector.writer.command({
    name: "flush-logs",
    query: "SYSTEM FLUSH LOGS",
  })({});
  if (flushError) throw flushError;

  const [error, rows] = await inspector.reader.query({
    name: "read-event-read-limits",
    query: `SELECT Settings['max_execution_time'] AS max_execution_time
      FROM system.query_log
      WHERE type = 'QueryFinish'
        AND query_kind = 'Select'
        AND has(tables, 'trigger_dev.task_events_v2')
        AND query_start_time_microseconds > toDateTime64({since: String}, 6)`,
    params: z.object({ since: z.string() }),
    schema: z.object({ max_execution_time: z.string() }),
  })({ since });
  await inspector.close();
  if (error) throw error;

  return rows.map((row) => row.max_execution_time);
}

describe("event read limits", () => {
  clickhouseTest("export reads use the export limit", async ({ clickhouseContainer }) => {
    const url = clickhouseContainer.getConnectionUrl();
    const { clickhouse, repository } = await setup(url);
    const since = await serverNow(url);

    const exported: string[] = [];
    for await (const event of repository.streamTraceEvents(
      "taskEventPartitioned",
      ENV_ID,
      TRACE_ID,
      new Date(BASE.getTime() - 60_000),
      new Date(BASE.getTime() + 60_000)
    )) {
      exported.push(event.spanId);
    }

    expect(exported).toEqual(["root"]);
    expect(await eventReadLimits(url, since)).toEqual(["300"]);

    await shutdown(clickhouse, repository);
  });

  clickhouseTest("interactive reads use the reader limit", async ({ clickhouseContainer }) => {
    const url = clickhouseContainer.getConnectionUrl();
    const { clickhouse, repository } = await setup(url);
    const since = await serverNow(url);

    const chunk = await repository.getTraceChunk(
      "taskEventPartitioned",
      ENV_ID,
      TRACE_ID,
      new Date(BASE.getTime() - 60_000),
      new Date(BASE.getTime() + 60_000),
      undefined,
      { includeDebugLogs: true, limit: 100 }
    );

    expect(chunk?.events.map((event) => event.spanId)).toEqual(["root"]);
    expect(new Set(await eventReadLimits(url, since))).toEqual(new Set(["30"]));

    await shutdown(clickhouse, repository);
  });
});
