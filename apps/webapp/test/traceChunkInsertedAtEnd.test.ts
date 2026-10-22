import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { TraceChunkScopeOptions } from "~/v3/eventRepository/eventRepository.types";

vi.setConfig({ testTimeout: 60_000 });

const TRACE_ID = "trace_inserted_at_end_test";
const ENV_ID = "env_inserted_at_end_test";
const BASE = new Date("2026-09-01T10:00:00.000Z");
const BOUND = new Date(BASE.getTime() + 60 * 60_000);
const LATE = new Date(BOUND.getTime() + 60_000);

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function row(
  spanId: string,
  message: string,
  status: "PARTIAL" | "OK",
  insertedAt: Date
): TaskEventV2Input {
  return {
    environment_id: ENV_ID,
    organization_id: "org_inserted_at_end_test",
    project_id: "project_inserted_at_end_test",
    task_identifier: "inserted-at-end-task",
    run_id: "run_inserted_at_end_test",
    start_time: clickhouseDate(BASE),
    inserted_at: convertDateToClickhouseDateTime(insertedAt),
    duration: "1000000",
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: "",
    message,
    kind: "SPAN",
    status,
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

async function readMessages(
  repository: ClickhouseEventRepository,
  options: TraceChunkScopeOptions & { limit?: number }
): Promise<string[]> {
  const chunk = await repository.getTraceChunk(
    "taskEventPartitioned",
    ENV_ID,
    TRACE_ID,
    new Date(BASE.getTime() - 60_000),
    new Date(BASE.getTime() + 60_000),
    undefined,
    options
  );
  return (chunk?.events ?? []).map((e) => e.message).sort();
}

describe("getTraceChunk insertedAtEnd", () => {
  clickhouseTest("excludes rows written after the bound", async ({ clickhouseContainer }) => {
    const clickhouse = new ClickHouse({
      url: clickhouseContainer.getConnectionUrl(),
      name: "test",
    });
    const repository = new ClickhouseEventRepository({
      clickhouse,
      version: "v2",
      insertStrategy: "insert",
    });

    try {
      const [insertError] = await clickhouse.taskEventsV2.insert([
        row("a", "a-final", "OK", BASE),
        row("b", "b-partial", "PARTIAL", BASE),
        row("b", "b-final", "OK", LATE),
      ]);
      expect(insertError).toBeNull();

      expect(await readMessages(repository, { insertedAtEnd: BOUND })).toEqual([
        "a-final",
        "b-partial",
      ]);
      expect(await readMessages(repository, {})).toEqual(["a-final", "b-final", "b-partial"]);
    } finally {
      await shutdownRepository(repository);
    }
  });

  clickhouseTest("applies the bound to the same-key regroup", async ({ clickhouseContainer }) => {
    const clickhouse = new ClickHouse({
      url: clickhouseContainer.getConnectionUrl(),
      name: "test",
    });
    const repository = new ClickhouseEventRepository({
      clickhouse,
      version: "v2",
      insertStrategy: "insert",
    });

    try {
      const [insertError] = await clickhouse.taskEventsV2.insert([
        row("same", "same-1", "PARTIAL", BASE),
        row("same", "same-2", "PARTIAL", BASE),
        row("same", "same-3", "PARTIAL", BASE),
        row("same", "same-late", "OK", LATE),
      ]);
      expect(insertError).toBeNull();

      // A limit smaller than the key forces the regroup query.
      expect(await readMessages(repository, { limit: 2, insertedAtEnd: BOUND })).toEqual([
        "same-1",
        "same-2",
        "same-3",
      ]);
      expect(await readMessages(repository, { limit: 2 })).toEqual([
        "same-1",
        "same-2",
        "same-3",
        "same-late",
      ]);
    } finally {
      await shutdownRepository(repository);
    }
  });
});
