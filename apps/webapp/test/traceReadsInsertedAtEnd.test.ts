import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

vi.setConfig({ testTimeout: 60_000 });

const TRACE_ID = "trace_reads_inserted_at_end";
const ENV_ID = "env_reads_inserted_at_end";
const RUN_ID = "run_reads_inserted_at_end";
const BASE = new Date("2026-09-01T10:00:00.000Z");
const BOUND = new Date(BASE.getTime() + 60 * 60_000);
const LATE = new Date(BOUND.getTime() + 60_000);
const WINDOW_START = new Date(BASE.getTime() - 60_000);
const WINDOW_END = new Date(BASE.getTime() + 60_000);

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function row(
  spanId: string,
  parentSpanId: string,
  status: "PARTIAL" | "OK",
  insertedAt: Date
): TaskEventV2Input {
  return {
    environment_id: ENV_ID,
    organization_id: "org_reads_inserted_at_end",
    project_id: "project_reads_inserted_at_end",
    task_identifier: "reads-inserted-at-end-task",
    run_id: RUN_ID,
    start_time: clickhouseDate(BASE),
    inserted_at: convertDateToClickhouseDateTime(insertedAt),
    duration: "1000000",
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: parentSpanId,
    message: `span-${spanId}`,
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

// Root "a" is final at BASE; child "b" is partial at BASE and only finishes after BOUND.
async function withSeededRepository(
  url: string,
  fn: (repository: ClickhouseEventRepository) => Promise<void>
) {
  const clickhouse = new ClickHouse({ url, name: "test" });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    insertStrategy: "insert",
  });

  try {
    const [insertError] = await clickhouse.taskEventsV2.insert([
      row("a", "", "OK", BASE),
      row("b", "a", "PARTIAL", BASE),
      row("b", "a", "OK", LATE),
    ]);
    expect(insertError).toBeNull();
    await fn(repository);
  } finally {
    await shutdownRepository(repository);
  }
}

describe("trace reads insertedAtEnd", () => {
  clickhouseTest(
    "getTraceSummary drops rows written after the bound",
    async ({ clickhouseContainer }) => {
      await withSeededRepository(clickhouseContainer.getConnectionUrl(), async (repository) => {
        const read = (insertedAtEnd?: Date) =>
          repository.getTraceSummary(
            "taskEventPartitioned",
            ENV_ID,
            TRACE_ID,
            WINDOW_START,
            WINDOW_END,
            {
              anchorSpanId: "a",
              insertedAtEnd,
            }
          );

        const bounded = await read(BOUND);
        expect(bounded?.spans.find((s) => s.id === "b")?.data.isPartial).toBe(true);

        const unbounded = await read();
        expect(unbounded?.spans.find((s) => s.id === "b")?.data.isPartial).toBe(false);
      });
    }
  );

  clickhouseTest(
    "getTraceSubtreeSummary drops rows written after the bound",
    async ({ clickhouseContainer }) => {
      await withSeededRepository(clickhouseContainer.getConnectionUrl(), async (repository) => {
        const read = (insertedAtEnd?: Date) =>
          repository.getTraceSubtreeSummary(
            "taskEventPartitioned",
            ENV_ID,
            TRACE_ID,
            "a",
            WINDOW_START,
            WINDOW_END,
            { insertedAtEnd }
          );

        const bounded = await read(BOUND);
        expect(bounded?.spans.find((s) => s.id === "b")?.data.isPartial).toBe(true);

        const unbounded = await read();
        expect(unbounded?.spans.find((s) => s.id === "b")?.data.isPartial).toBe(false);
      });
    }
  );

  clickhouseTest("getSpan drops rows written after the bound", async ({ clickhouseContainer }) => {
    await withSeededRepository(clickhouseContainer.getConnectionUrl(), async (repository) => {
      const read = (insertedAtEnd?: Date) =>
        repository.getSpan(
          "taskEventPartitioned",
          ENV_ID,
          "b",
          TRACE_ID,
          WINDOW_START,
          WINDOW_END,
          {
            insertedAtEnd,
          }
        );

      expect((await read(BOUND))?.isPartial).toBe(true);
      expect((await read())?.isPartial).toBe(false);
    });
  });

  clickhouseTest(
    "getRunEvents drops rows written after the bound",
    async ({ clickhouseContainer }) => {
      await withSeededRepository(clickhouseContainer.getConnectionUrl(), async (repository) => {
        const read = async (insertedAtEnd?: Date) => {
          const events = await repository.getRunEvents(
            "taskEventPartitioned",
            ENV_ID,
            TRACE_ID,
            RUN_ID,
            WINDOW_START,
            WINDOW_END,
            { insertedAtEnd }
          );
          return events.find((e) => e.spanId === "b")?.isPartial;
        };

        expect(await read(BOUND)).toBe(true);
        expect(await read()).toBe(false);
      });
    }
  );
});
