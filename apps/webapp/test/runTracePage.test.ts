import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import {
  assembleRunTracePages,
  type RetrieveRunTracePageResponseBody,
  type RunTraceNode,
} from "@trigger.dev/core/v3";
import { describe, expect, it, vi } from "vitest";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { SpanDetailedSummary } from "~/v3/eventRepository/eventRepository.types";
import { decodeTraceCursor } from "~/v3/eventRepository/traceCursor";
import { getRunTracePage, type RunTracePageRun } from "~/v3/eventRepository/runTracePage.server";

vi.setConfig({ testTimeout: 60_000 });

const ENV_ID = "env_run_trace_page_test";
const BASE = new Date("2026-09-01T10:00:00.000Z");

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function row(
  traceId: string,
  spanId: string,
  options: {
    parentSpanId?: string;
    offsetMs?: number;
    kind?: string;
    status?: string;
    message?: string;
    metadata?: Record<string, unknown>;
    durationMs?: number;
    runId?: string;
    // Sub-millisecond part of the start time, as final rows carry nanoseconds.
    extraNanos?: number;
  } = {}
): TaskEventV2Input {
  const startTime = new Date(BASE.getTime() + (options.offsetMs ?? 0));
  const nanos = String(
    startTime.getUTCMilliseconds() * 1_000_000 + (options.extraNanos ?? 0)
  ).padStart(9, "0");
  return {
    environment_id: ENV_ID,
    organization_id: "org_run_trace_page_test",
    project_id: "project_run_trace_page_test",
    task_identifier: "run-trace-page-task",
    run_id: options.runId ?? "run_1",
    start_time: `${clickhouseDate(startTime).slice(0, 19)}.${nanos}`,
    inserted_at: convertDateToClickhouseDateTime(startTime),
    duration: String((options.durationMs ?? 1) * 1_000_000),
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: options.parentSpanId ?? "",
    message: options.message ?? spanId,
    kind: options.kind ?? "SPAN",
    status: options.status ?? "OK",
    attributes: {},
    metadata: JSON.stringify(options.metadata ?? {}),
    expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
  };
}

function rootRun(traceId: string, overrides: Partial<RunTracePageRun> = {}): RunTracePageRun {
  return {
    traceId,
    status: "COMPLETED_SUCCESSFULLY",
    createdAt: BASE,
    completedAt: new Date(BASE.getTime() + 10_000),
    updatedAt: new Date(BASE.getTime() + 10_000),
    ...overrides,
  };
}

function createRepository(url: string, maximumKeyRows?: number) {
  const clickhouse = new ClickHouse({ url, name: "test" });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    insertStrategy: "insert",
    maximumKeyRows,
  });
  return { clickhouse, repository };
}

async function shutdownRepository(repository: ClickhouseEventRepository): Promise<void> {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

async function pageAll(
  repository: ClickhouseEventRepository,
  run: RunTracePageRun,
  limit: number
): Promise<RetrieveRunTracePageResponseBody[]> {
  const pages: RetrieveRunTracePageResponseBody[] = [];
  let next: string | undefined;

  do {
    if (pages.length > 200) throw new Error("paging did not terminate");
    const after = next ? decodeTraceCursor(next)._unsafeUnwrap() : undefined;
    const page = await getRunTracePage({
      repository,
      storeTable: "taskEventPartitioned",
      environmentId: ENV_ID,
      run,
      pageRequest: { limit, after },
    });
    pages.push(page._unsafeUnwrap());
    next = page._unsafeUnwrap().pagination.next;
  } while (next);

  return pages;
}

type SpanState = { isError: boolean; isPartial: boolean; isCancelled: boolean };

function pagedStates(roots: RunTraceNode[]): Record<string, SpanState> {
  const out: Record<string, SpanState> = {};
  const walk = (node: RunTraceNode) => {
    out[node.id] = {
      isError: node.isError,
      isPartial: node.isPartial,
      isCancelled: node.isCancelled,
    };
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

function unpagedStates(root: SpanDetailedSummary): Record<string, SpanState> {
  const out: Record<string, SpanState> = {};
  const walk = (node: SpanDetailedSummary) => {
    const { isError, isPartial, isCancelled } = node.data;
    out[node.id] = { isError, isPartial, isCancelled };
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}

async function unpaged(
  repository: ClickhouseEventRepository,
  run: RunTracePageRun,
  rootSpanId: string
) {
  const summary = await repository.getTraceDetailedSubtreeSummary(
    "taskEventPartitioned",
    ENV_ID,
    run.traceId,
    rootSpanId,
    run.createdAt,
    run.completedAt ?? undefined
  );
  if (!summary) throw new Error("no unpaged summary");
  return unpagedStates(summary.rootSpan);
}

describe("getRunTracePage", () => {
  clickhouseTest("pages a root run to completion without gaps", async ({ clickhouseContainer }) => {
    const { clickhouse, repository } = createRepository(clickhouseContainer.getConnectionUrl());
    const traceId = "trace_page_all";

    try {
      const rows: TaskEventV2Input[] = [row(traceId, "root", { durationMs: 9_000 })];
      for (let i = 0; i < 30; i++) {
        rows.push(
          row(traceId, `s${String(i).padStart(2, "0")}`, { parentSpanId: "root", offsetMs: 10 + i })
        );
      }
      // Final row with nanoseconds, partial row on a later millisecond: different keys and pages.
      rows.push(row(traceId, "split", { parentSpanId: "root", offsetMs: 13, extraNanos: 250_000 }));
      rows.push(row(traceId, "split", { parentSpanId: "root", offsetMs: 20, status: "PARTIAL" }));
      const [insertError] = await clickhouse.taskEventsV2.insert(rows);
      expect(insertError).toBeNull();

      const pages = await pageAll(repository, rootRun(traceId), 4);
      const ids = pages.flatMap((page) => page.data.map((span) => span.id));

      expect(pages.length).toBeGreaterThan(1);
      expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.span_id)));
      expect(pages.every((page) => page.data.length <= 4)).toBe(true);
      expect(pages.at(-1)?.pagination.next).toBeUndefined();
      expect(pages.filter((page) => page.data.some((s) => s.id === "split"))).toHaveLength(2);

      const nodes = Object.values(pagedStates(assembleRunTracePages(pages)));
      expect(nodes).toHaveLength(new Set(ids).size);
      expect(pagedStates(assembleRunTracePages(pages)).split.isPartial).toBe(false);
    } finally {
      await shutdownRepository(repository);
    }
  });

  clickhouseTest(
    "reassembled pages match the unpaged states for a cancelled parent",
    async ({ clickhouseContainer }) => {
      const { clickhouse, repository } = createRepository(clickhouseContainer.getConnectionUrl());
      const traceId = "trace_cancelled";

      try {
        const [insertError] = await clickhouse.taskEventsV2.insert([
          row(traceId, "root", { status: "CANCELLED", durationMs: 10_000 }),
          row(traceId, "child", { parentSpanId: "root", offsetMs: 1_000, status: "PARTIAL" }),
          row(traceId, "grandchild", { parentSpanId: "child", offsetMs: 2_000, status: "PARTIAL" }),
          row(traceId, "done", { parentSpanId: "root", offsetMs: 3_000, extraNanos: 400_000 }),
          row(traceId, "done", { parentSpanId: "root", offsetMs: 3_001, status: "PARTIAL" }),
          row(traceId, "debug", { parentSpanId: "root", offsetMs: 4_000, kind: "DEBUG_EVENT" }),
        ]);
        expect(insertError).toBeNull();

        const run = rootRun(traceId, { status: "CANCELED" });
        const paged = pagedStates(assembleRunTracePages(await pageAll(repository, run, 2)));

        expect(paged).toEqual(await unpaged(repository, run, "root"));
        expect(paged.grandchild.isCancelled).toBe(true);
        expect(paged.done).toEqual({ isError: false, isPartial: false, isCancelled: false });
        expect(paged.debug).toBeDefined();
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  clickhouseTest(
    "applies a failed attempt recorded on a later page, as the unpaged trace does",
    async ({ clickhouseContainer }) => {
      const { clickhouse, repository } = createRepository(clickhouseContainer.getConnectionUrl());
      const traceId = "trace_attempt_failed";

      try {
        const [insertError] = await clickhouse.taskEventsV2.insert([
          row(traceId, "root", { status: "ERROR", durationMs: 10_000 }),
          row(traceId, "attempt", {
            parentSpanId: "root",
            offsetMs: 1_000,
            status: "PARTIAL",
            metadata: { attemptNumber: 1 },
          }),
          row(traceId, "other-attempt", {
            parentSpanId: "root",
            offsetMs: 2_000,
            status: "PARTIAL",
            metadata: { attemptNumber: 2 },
          }),
          row(traceId, "root", {
            offsetMs: 9_000,
            kind: "ANCESTOR_OVERRIDE",
            message: "attempt_failed",
            metadata: { exception: {}, attemptNumber: 1, runId: "run_1" },
          }),
        ]);
        expect(insertError).toBeNull();

        const run = rootRun(traceId, { status: "COMPLETED_WITH_ERRORS" });
        const pages = await pageAll(repository, run, 2);

        expect(pages.at(-1)?.attemptFailures).toEqual([
          { spanId: "root", attemptNumber: 1, runId: "run_1" },
        ]);
        expect(pages.flatMap((p) => p.data).filter((s) => s.id === "root")).toHaveLength(1);

        const paged = pagedStates(assembleRunTracePages(pages));
        expect(paged).toEqual(await unpaged(repository, run, "root"));
        expect(paged.attempt.isError).toBe(true);
        expect(paged["other-attempt"].isPartial).toBe(true);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  clickhouseTest(
    "marks a page truncated when one span has more rows than one read allows",
    async ({ clickhouseContainer }) => {
      const { clickhouse, repository } = createRepository(
        clickhouseContainer.getConnectionUrl(),
        3
      );
      const traceId = "trace_dropped_key_rows";

      try {
        const rows = [row(traceId, "root", { durationMs: 9_000 })];
        for (let i = 0; i < 6; i++) {
          rows.push(row(traceId, "big", { parentSpanId: "root", offsetMs: 10, status: "PARTIAL" }));
        }
        rows.push(row(traceId, "after", { parentSpanId: "root", offsetMs: 20 }));
        const [insertError] = await clickhouse.taskEventsV2.insert(rows);
        expect(insertError).toBeNull();

        const pages = await pageAll(repository, rootRun(traceId), 2);
        const truncatedPages = pages.filter((p) => p.pagination.truncated);
        expect(truncatedPages).toHaveLength(1);
        expect(truncatedPages[0]?.data.map((s) => s.id)).toEqual(["big"]);
        expect(truncatedPages[0]?.pagination.next).toBeDefined();
        expect(pages.flatMap((p) => p.data.map((s) => s.id))).toContain("after");
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  clickhouseTest(
    "stops after one page when asked to (emergency span cap)",
    async ({ clickhouseContainer }) => {
      const { clickhouse, repository } = createRepository(clickhouseContainer.getConnectionUrl());
      const traceId = "trace_stop_after_page";

      try {
        const rows = [row(traceId, "root", { durationMs: 9_000 })];
        for (let i = 0; i < 10; i++) {
          rows.push(row(traceId, `s${i}`, { parentSpanId: "root", offsetMs: 10 + i }));
        }
        const [insertError] = await clickhouse.taskEventsV2.insert(rows);
        expect(insertError).toBeNull();

        const page = await getRunTracePage({
          repository,
          storeTable: "taskEventPartitioned",
          environmentId: ENV_ID,
          run: rootRun(traceId),
          pageRequest: { limit: 4, after: undefined },
          stopAfterPage: true,
        });

        expect(page._unsafeUnwrap().data).toHaveLength(4);
        expect(page._unsafeUnwrap().pagination).toEqual({ truncated: true });

        const whole = await getRunTracePage({
          repository,
          storeTable: "taskEventPartitioned",
          environmentId: ENV_ID,
          run: rootRun(traceId),
          pageRequest: { limit: 50, after: undefined },
          stopAfterPage: true,
        });
        expect(whole._unsafeUnwrap().data).toHaveLength(11);
        expect(whole._unsafeUnwrap().pagination).toEqual({});
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  it("reports an unreachable store as unavailable", async () => {
    const { repository } = createRepository("http://127.0.0.1:1");
    try {
      const page = await getRunTracePage({
        repository,
        storeTable: "taskEventPartitioned",
        environmentId: ENV_ID,
        run: rootRun("trace_unreachable"),
        pageRequest: { limit: 50, after: undefined },
      });
      expect(page.isErr() && page.error).toBe("store_unavailable");
    } finally {
      await shutdownRepository(repository);
    }
  });
});
