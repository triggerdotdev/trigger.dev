import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { assembleRunTracePages, type RetrieveRunTracePageResponseBody } from "@trigger.dev/core/v3";
import { describe, expect } from "vitest";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { decodeTraceCursor } from "~/v3/eventRepository/traceCursor";
import { getRunTracePage } from "~/v3/eventRepository/runTracePage.server";

const ENV_ID = "env_run_trace_page_perf";
const TRACE_ID = "trace_run_trace_page_perf";
const BASE = new Date("2026-09-01T10:00:00.000Z");
const SPAN_COUNT = 30_000;
const PAGE_SIZE = 1_000;

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function row(
  spanId: string,
  parentSpanId: string,
  offsetMs: number,
  status: string
): TaskEventV2Input {
  const startTime = new Date(BASE.getTime() + offsetMs);
  return {
    environment_id: ENV_ID,
    organization_id: "org_run_trace_page_perf",
    project_id: "project_run_trace_page_perf",
    task_identifier: "run-trace-page-perf",
    run_id: "run_perf",
    start_time: clickhouseDate(startTime),
    inserted_at: convertDateToClickhouseDateTime(startTime),
    duration: "1000000",
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: parentSpanId,
    message: spanId,
    kind: "SPAN",
    status,
    attributes: {},
    metadata: "{}",
    expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
  };
}

describe("getRunTracePage on a large trace", () => {
  clickhouseTest(
    "pages every span of a trace far above the unpaged cap",
    async ({ clickhouseContainer }) => {
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
        const rows: TaskEventV2Input[] = [row("root", "", 0, "OK")];
        for (let i = 0; i < SPAN_COUNT; i++) {
          const id = `s${i}`;
          const parent = i < 100 ? "root" : `s${i % 100}`;
          rows.push(row(id, parent, 1 + Math.floor(i / 10), "PARTIAL"));
          rows.push(row(id, parent, 1 + Math.floor(i / 10), "OK"));
        }
        const [insertError] = await clickhouse.taskEventsV2.insert(rows);
        expect(insertError).toBeNull();

        const pages: RetrieveRunTracePageResponseBody[] = [];
        let next: string | undefined;
        do {
          const page = await getRunTracePage({
            repository,
            storeTable: "taskEventPartitioned",
            environmentId: ENV_ID,
            run: {
              traceId: TRACE_ID,
              parentTaskRunId: null,
              status: "COMPLETED_SUCCESSFULLY",
              createdAt: BASE,
              completedAt: new Date(BASE.getTime() + 60_000),
              updatedAt: new Date(BASE.getTime() + 60_000),
            },
            pageRequest: {
              limit: PAGE_SIZE,
              after: next ? decodeTraceCursor(next)._unsafeUnwrap() : undefined,
            },
          });
          pages.push(page._unsafeUnwrap());
          next = page._unsafeUnwrap().pagination.next;
        } while (next && pages.length < 1_000);

        const spans = pages.flatMap((page) => page.data);
        expect(new Set(spans.map((span) => span.id)).size).toBe(SPAN_COUNT + 1);
        expect(spans.length).toBe(SPAN_COUNT + 1);
        expect(spans.every((span) => !span.isPartial)).toBe(true);
        expect(pages.every((page) => page.data.length <= PAGE_SIZE)).toBe(true);

        const roots = assembleRunTracePages(pages);
        expect(roots.map((root) => root.id)).toEqual(["root"]);
      } finally {
        await Promise.all([
          (repository as any)._flushScheduler.shutdown(),
          (repository as any)._llmMetricsFlushScheduler.shutdown(),
          (repository as any)._otlpMetricsFlushScheduler.shutdown(),
        ]);
      }
    },
    300_000
  );
});
