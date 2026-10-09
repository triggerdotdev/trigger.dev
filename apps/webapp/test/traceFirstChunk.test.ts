import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import {
  assembleFirstTraceChunk,
  type TraceReadScope,
} from "~/presenters/v3/traceFirstChunk.server";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";

vi.setConfig({ testTimeout: 60_000 });

const TRACE_ID = "trace_first_chunk_test";
const ENV_ID = "env_first_chunk_test";
const ROOT_AT = new Date("2026-09-01T10:00:00.000Z");
const CHILD_AT = new Date(ROOT_AT.getTime() + 2 * 86_400_000);

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function row(spanId: string, at: Date, parentSpanId: string): TaskEventV2Input {
  return {
    environment_id: ENV_ID,
    organization_id: "org_first_chunk_test",
    project_id: "project_first_chunk_test",
    task_identifier: "first-chunk-task",
    run_id: "run_first_chunk_test",
    start_time: clickhouseDate(at),
    inserted_at: clickhouseDate(at),
    duration: "1000000",
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: parentSpanId,
    message: spanId,
    kind: "SPAN",
    status: "OK",
    attributes: {},
    metadata: "{}",
    expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
  };
}

// Batch siblings created in the 50s before the child, enough to fill a 1,000-row page.
const SIBLINGS = Array.from({ length: 1_200 }, (_, i) =>
  row(`batch-${String(i).padStart(4, "0")}`, new Date(CHILD_AT.getTime() - 50_000 + i * 40), "root")
);

const SCOPE: TraceReadScope = {
  storeTable: "taskEventPartitioned",
  environmentId: ENV_ID,
  traceId: TRACE_ID,
  startCreatedAt: CHILD_AT,
  endCreatedAt: undefined,
};

async function withRepository(
  url: string,
  rows: TaskEventV2Input[],
  fn: (repository: ClickhouseEventRepository) => Promise<void>
) {
  const clickhouse = new ClickHouse({ url, name: "test" });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    insertStrategy: "insert",
  });
  try {
    if (rows.length > 0) {
      const [insertError] = await clickhouse.taskEventsV2.insert(rows);
      expect(insertError).toBeNull();
    }
    await fn(repository);
  } finally {
    await Promise.all([
      (repository as any)._flushScheduler.shutdown(),
      (repository as any)._llmMetricsFlushScheduler.shutdown(),
      (repository as any)._otlpMetricsFlushScheduler.shutdown(),
    ]);
  }
}

async function firstChunkOf(repository: ClickhouseEventRepository) {
  const chunk = await repository.getTraceChunk(
    SCOPE.storeTable,
    SCOPE.environmentId,
    SCOPE.traceId,
    SCOPE.startCreatedAt,
    SCOPE.endCreatedAt,
    undefined,
    { includeDebugLogs: true, limit: 1_000 }
  );
  expect(chunk).toBeDefined();
  return chunk!;
}

describe("assembleFirstTraceChunk", () => {
  clickhouseTest(
    "fetches an anchor crowded out of the first chunk and stays progressive",
    async ({ clickhouseContainer }) => {
      const rows = [
        row("root", ROOT_AT, ""),
        ...SIBLINGS,
        row("child", CHILD_AT, "root"),
        row("child-attempt", new Date(CHILD_AT.getTime() + 1_000), "child"),
      ];
      await withRepository(clickhouseContainer.getConnectionUrl(), rows, async (repository) => {
        const firstChunk = await firstChunkOf(repository);
        expect(firstChunk.events.some((e) => e.spanId === "child")).toBe(false);

        const result = await assembleFirstTraceChunk({
          repository,
          scope: SCOPE,
          firstChunk,
          anchorSpanId: "child",
          selectedSpanId: undefined,
          showDebug: true,
          isAdmin: false,
        });

        expect(result.kind).toBe("progressive");
        if (result.kind !== "progressive") return;
        expect(result.assembler.hasSpan("child")).toBe(true);
        expect(result.supplementaryFirstEvents?.map((e) => e.spanId)).toEqual(["child"]);
        expect(result.hasMore).toBe(true);
      });
    }
  );

  clickhouseTest(
    "falls back when the anchor doesn't exist in the window",
    async ({ clickhouseContainer }) => {
      await withRepository(
        clickhouseContainer.getConnectionUrl(),
        [row("root", ROOT_AT, ""), ...SIBLINGS],
        async (repository) => {
          const result = await assembleFirstTraceChunk({
            repository,
            scope: SCOPE,
            firstChunk: await firstChunkOf(repository),
            anchorSpanId: "child",
            selectedSpanId: undefined,
            showDebug: true,
            isAdmin: false,
          });

          expect(result).toEqual({ kind: "fallback", reason: "anchorMissing" });
        }
      );
    }
  );

  clickhouseTest(
    "reports an empty trace without further reads",
    async ({ clickhouseContainer }) => {
      await withRepository(clickhouseContainer.getConnectionUrl(), [], async (repository) => {
        const lookups = vi.spyOn(repository, "getTraceSpanWithAncestors");

        const result = await assembleFirstTraceChunk({
          repository,
          scope: SCOPE,
          firstChunk: await firstChunkOf(repository),
          anchorSpanId: "child",
          selectedSpanId: "child",
          showDebug: true,
          isAdmin: false,
        });

        expect(result).toEqual({ kind: "empty" });
        expect(lookups).not.toHaveBeenCalled();
      });
    }
  );

  clickhouseTest(
    "a selected span inside the run covers the anchor with one lookup",
    async ({ clickhouseContainer }) => {
      const rows = [
        row("root", ROOT_AT, ""),
        ...SIBLINGS,
        row("child", CHILD_AT, "root"),
        row("child-attempt", new Date(CHILD_AT.getTime() + 1_000), "child"),
      ];
      await withRepository(clickhouseContainer.getConnectionUrl(), rows, async (repository) => {
        const lookups = vi.spyOn(repository, "getTraceSpanWithAncestors");

        const result = await assembleFirstTraceChunk({
          repository,
          scope: SCOPE,
          firstChunk: await firstChunkOf(repository),
          anchorSpanId: "child",
          selectedSpanId: "child-attempt",
          showDebug: true,
          isAdmin: false,
        });

        expect(result.kind).toBe("progressive");
        if (result.kind !== "progressive") return;
        expect(lookups).toHaveBeenCalledTimes(1);
        expect(result.supplementaryFirstEvents?.map((e) => e.spanId).sort()).toEqual([
          "child",
          "child-attempt",
        ]);
      });
    }
  );

  clickhouseTest(
    "overlapping walks don't duplicate shared ancestor rows",
    async ({ clickhouseContainer }) => {
      // A parent span inside the child's window is an ancestor of both the child and
      // a sibling past the first chunk.
      const parentAttempt = row("parent-attempt", new Date(CHILD_AT.getTime() - 55_000), "root");
      const siblings = SIBLINGS.map((sibling) => ({
        ...sibling,
        parent_span_id: "parent-attempt",
      }));
      const exception: TaskEventV2Input = {
        ...row("child", new Date(CHILD_AT.getTime() + 500), "parent-attempt"),
        kind: "SPAN_EVENT",
        message: "exception",
      };
      const rows = [
        row("root", ROOT_AT, ""),
        parentAttempt,
        { ...parentAttempt, message: "parent-attempt-complete" },
        ...siblings,
        row("child", CHILD_AT, "parent-attempt"),
        // Same span, time and name, different payloads: both are real events.
        { ...exception, metadata: JSON.stringify({ exception: { message: "first" } }) },
        { ...exception, metadata: JSON.stringify({ exception: { message: "second" } }) },
      ];
      await withRepository(clickhouseContainer.getConnectionUrl(), rows, async (repository) => {
        const firstChunk = await firstChunkOf(repository);
        // Drop the shared parent from the first chunk so both walks return it.
        const trimmed = {
          ...firstChunk,
          events: firstChunk.events.filter((e) => e.spanId !== "parent-attempt"),
        };

        const result = await assembleFirstTraceChunk({
          repository,
          scope: SCOPE,
          firstChunk: trimmed,
          anchorSpanId: "child",
          selectedSpanId: "batch-1199",
          showDebug: true,
          isAdmin: false,
        });

        expect(result.kind).toBe("progressive");
        if (result.kind !== "progressive") return;
        const supplementary = result.supplementaryFirstEvents ?? [];
        expect(supplementary.filter((e) => e.spanId === "parent-attempt")).toHaveLength(2);
        expect(
          supplementary.filter((e) => e.spanId === "child" && e.message === "exception")
        ).toHaveLength(2);
        expect(new Set(supplementary.map((e) => e.spanId))).toEqual(
          new Set(["batch-1199", "parent-attempt", "child"])
        );
      });
    }
  );
});
