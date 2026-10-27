import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import type { SpanDetailedSummary } from "~/v3/eventRepository/eventRepository.types";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { createInMemoryTracing } from "./utils/tracing";

/**
 * Proves getTraceDetailedSubtreeSummary (used by GET /api/v1/runs/:runId/trace)
 * returns a tree rooted at the requested run's span — not the trace-wide root.
 *
 * Reproduces the large-trace failure mode: a full-trace fetch is capped by
 * ORDER BY start_time ASC LIMIT N, so late spans are excluded. Subtree fetch
 * looks up the anchor span directly and still returns the run-scoped tree.
 */
const INTEGRATION_TIMEOUT_MS = 60_000;
const TRACE_ROW_LIMIT = 50;
const FILLER_COUNT = 60;

function startTimeNs(baseMs: number, offsetMs: number): string {
  return ((BigInt(baseMs) + BigInt(offsetMs)) * 1_000_000n).toString();
}

function formatClickhouseStartTime(baseMs: number, offsetMs: number): string {
  const nanoseconds = startTimeNs(baseMs, offsetMs);
  if (nanoseconds.length !== 19) {
    return nanoseconds;
  }

  return `${nanoseconds.substring(0, 10)}.${nanoseconds.substring(10)}`;
}

function findSpan(
  span: SpanDetailedSummary | undefined,
  spanId: string
): SpanDetailedSummary | undefined {
  if (!span) {
    return undefined;
  }
  if (span.id === spanId) {
    return span;
  }
  for (const child of span.children) {
    const found = findSpan(child, spanId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

describe("getTraceDetailedSubtreeSummary", () => {
  clickhouseTest(
    "roots the API trace at the requested run span even when it is outside the full-trace row cap",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "warn",
      });

      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        maximumTraceDetailedSummaryViewCount: TRACE_ROW_LIMIT,
      });

      const environmentId = "env_trace_subtree_test";
      const organizationId = "org_trace_subtree_test";
      const projectId = "proj_trace_subtree_test";
      const traceId = "a".repeat(32);
      const spanRoot = "rootspan00000001";
      const spanChild = "childspan0000001";
      const spanGrandchild = "grandchildspan01";
      const runRoot = "run_root_task_run";
      const runChild = "run_child_task_run";
      const baseMs = Date.now();
      const runCreatedAt = new Date(baseMs - 60_000);
      const expiresAt = convertDateToClickhouseDateTime(
        new Date(baseMs + 365 * 24 * 60 * 60 * 1000)
      );

      function makeSpanRow({
        spanId,
        parentSpanId,
        runId,
        startOffsetMs,
        message,
      }: {
        spanId: string;
        parentSpanId: string;
        runId: string;
        startOffsetMs: number;
        message: string;
      }): TaskEventV2Input {
        return {
          environment_id: environmentId,
          organization_id: organizationId,
          project_id: projectId,
          task_identifier: "subtree-test-task",
          run_id: runId,
          start_time: formatClickhouseStartTime(baseMs, startOffsetMs),
          duration: "1000000",
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          message,
          kind: "SPAN",
          status: "OK",
          attributes: {},
          metadata: "{}",
          expires_at: expiresAt,
        };
      }

      const rows: TaskEventV2Input[] = [
        makeSpanRow({
          spanId: spanRoot,
          parentSpanId: "",
          runId: runRoot,
          startOffsetMs: 0,
          message: "root task",
        }),
        ...Array.from({ length: FILLER_COUNT }, (_, index) =>
          makeSpanRow({
            spanId: `filler${String(index).padStart(10, "0")}`,
            parentSpanId: spanRoot,
            runId: runRoot,
            startOffsetMs: index + 1,
            message: `filler span ${index}`,
          })
        ),
        makeSpanRow({
          spanId: spanChild,
          parentSpanId: spanRoot,
          runId: runChild,
          startOffsetMs: 100_000,
          message: "child task",
        }),
        makeSpanRow({
          spanId: spanGrandchild,
          parentSpanId: spanChild,
          runId: runChild,
          startOffsetMs: 100_001,
          message: "grandchild span",
        }),
      ];

      const [insertError] = await clickhouse.taskEventsV2.insert(rows, {
        clickhouse_settings: { async_insert: 0 },
      });
      expect(insertError).toBeNull();

      const fullTrace = await repository.getTraceDetailedSummary(
        "taskEvent",
        environmentId,
        traceId,
        runCreatedAt
      );

      expect(fullTrace?.rootSpan.id).toBe(spanRoot);
      expect(fullTrace?.isTruncated).toBe(true);
      expect(findSpan(fullTrace?.rootSpan, spanChild)).toBeUndefined();

      const subtree = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        traceId,
        spanChild,
        runCreatedAt
      );

      expect(subtree).toBeDefined();
      expect(subtree!.isTruncated).toBe(false);
      expect(subtree!.traceId).toBe(traceId);
      expect(subtree!.rootSpan.id).toBe(spanChild);
      expect(subtree!.rootSpan.runId).toBe(runChild);
      expect(subtree!.rootSpan.parentId).toBe(spanRoot);
      expect(subtree!.rootSpan.children).toHaveLength(1);
      expect(subtree!.rootSpan.children[0]?.id).toBe(spanGrandchild);
      expect(subtree!.rootSpan.children[0]?.runId).toBe(runChild);
    },
    INTEGRATION_TIMEOUT_MS
  );

  clickhouseTest(
    "loads ancestors outside the anchor run time window for override propagation",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "warn",
      });

      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        maximumTraceDetailedSummaryViewCount: TRACE_ROW_LIMIT,
      });

      const environmentId = "env_trace_subtree_ancestor";
      const organizationId = "org_trace_subtree_ancestor";
      const projectId = "proj_trace_subtree_ancestor";
      const traceId = "b".repeat(32);
      const spanRoot = "rootspan00000002";
      const spanChild = "childspan0000002";
      const runRoot = "run_root_cancelled";
      const runChild = "run_child_partial";
      const baseMs = Date.now();
      const childRunCreatedAt = new Date(baseMs + 100_000);
      const expiresAt = convertDateToClickhouseDateTime(
        new Date(baseMs + 365 * 24 * 60 * 60 * 1000)
      );

      function makeSpanRow({
        spanId,
        parentSpanId,
        runId,
        startOffsetMs,
        insertedOffsetMs,
        message,
        status,
      }: {
        spanId: string;
        parentSpanId: string;
        runId: string;
        startOffsetMs: number;
        insertedOffsetMs: number;
        message: string;
        status: string;
      }): TaskEventV2Input {
        return {
          environment_id: environmentId,
          organization_id: organizationId,
          project_id: projectId,
          task_identifier: "subtree-ancestor-test-task",
          run_id: runId,
          start_time: formatClickhouseStartTime(baseMs, startOffsetMs),
          inserted_at: convertDateToClickhouseDateTime(new Date(baseMs + insertedOffsetMs)),
          duration: "5000000000",
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          message,
          kind: "SPAN",
          status,
          attributes: {},
          metadata: "{}",
          expires_at: expiresAt,
        };
      }

      const rows: TaskEventV2Input[] = [
        makeSpanRow({
          spanId: spanRoot,
          parentSpanId: "",
          runId: runRoot,
          startOffsetMs: 0,
          insertedOffsetMs: 0,
          message: "root task",
          status: "PARTIAL",
        }),
        makeSpanRow({
          spanId: spanRoot,
          parentSpanId: "",
          runId: runRoot,
          startOffsetMs: 5_000,
          insertedOffsetMs: 5_000,
          message: "root task",
          status: "CANCELLED",
        }),
        makeSpanRow({
          spanId: spanChild,
          parentSpanId: spanRoot,
          runId: runChild,
          startOffsetMs: 100_000,
          insertedOffsetMs: 100_000,
          message: "child task",
          status: "PARTIAL",
        }),
      ];

      const [insertError] = await clickhouse.taskEventsV2.insert(rows, {
        clickhouse_settings: { async_insert: 0 },
      });
      expect(insertError).toBeNull();

      const subtree = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        traceId,
        spanChild,
        childRunCreatedAt
      );

      expect(subtree).toBeDefined();
      expect(subtree!.rootSpan.id).toBe(spanChild);
      expect(subtree!.rootSpan.parentId).toBe(spanRoot);
      expect(subtree!.rootSpan.data.isPartial).toBe(false);
      expect(subtree!.rootSpan.data.isCancelled).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS
  );

  clickhouseTest(
    "re-roots from a single full-trace query when the anchor and parent are inside the row cap",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "warn",
      });

      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        maximumTraceDetailedSummaryViewCount: TRACE_ROW_LIMIT,
      });

      const environmentId = "env_trace_subtree_fast_path";
      const organizationId = "org_trace_subtree_fast_path";
      const projectId = "proj_trace_subtree_fast_path";
      const traceId = "c".repeat(32);
      const spanRoot = "rootspan00000003";
      const spanChild = "childspan0000003";
      const spanGrandchild = "grandchildspan03";
      const runRoot = "run_root_fast_path";
      const runChild = "run_child_fast_path";
      const baseMs = Date.now();
      const runCreatedAt = new Date(baseMs - 60_000);
      const expiresAt = convertDateToClickhouseDateTime(
        new Date(baseMs + 365 * 24 * 60 * 60 * 1000)
      );

      function makeSpanRow({
        spanId,
        parentSpanId,
        runId,
        startOffsetMs,
        message,
        status = "OK",
      }: {
        spanId: string;
        parentSpanId: string;
        runId: string;
        startOffsetMs: number;
        message: string;
        status?: string;
      }): TaskEventV2Input {
        return {
          environment_id: environmentId,
          organization_id: organizationId,
          project_id: projectId,
          task_identifier: "subtree-fast-path-task",
          run_id: runId,
          start_time: formatClickhouseStartTime(baseMs, startOffsetMs),
          inserted_at: convertDateToClickhouseDateTime(new Date(baseMs + startOffsetMs)),
          duration: "1000000",
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          message,
          kind: "SPAN",
          status,
          attributes: {},
          metadata: "{}",
          expires_at: expiresAt,
        };
      }

      const rows: TaskEventV2Input[] = [
        makeSpanRow({
          spanId: spanRoot,
          parentSpanId: "",
          runId: runRoot,
          startOffsetMs: 0,
          message: "root task",
          status: "PARTIAL",
        }),
        makeSpanRow({
          spanId: spanRoot,
          parentSpanId: "",
          runId: runRoot,
          startOffsetMs: 5_000,
          message: "root task",
          status: "CANCELLED",
        }),
        makeSpanRow({
          spanId: spanChild,
          parentSpanId: spanRoot,
          runId: runChild,
          startOffsetMs: 10_000,
          message: "child task",
          status: "PARTIAL",
        }),
        makeSpanRow({
          spanId: spanGrandchild,
          parentSpanId: spanChild,
          runId: runChild,
          startOffsetMs: 10_001,
          message: "grandchild span",
        }),
      ];

      const [insertError] = await clickhouse.taskEventsV2.insert(rows, {
        clickhouse_settings: { async_insert: 0 },
      });
      expect(insertError).toBeNull();

      const subtree = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        traceId,
        spanChild,
        runCreatedAt
      );

      expect(subtree).toBeDefined();
      expect(subtree!.isTruncated).toBe(false);
      expect(subtree!.rootSpan.id).toBe(spanChild);
      expect(subtree!.rootSpan.parentId).toBe(spanRoot);
      expect(subtree!.rootSpan.data.isPartial).toBe(false);
      expect(subtree!.rootSpan.data.isCancelled).toBe(true);
      expect(subtree!.rootSpan.children).toHaveLength(1);
      expect(subtree!.rootSpan.children[0]?.id).toBe(spanGrandchild);
    },
    INTEGRATION_TIMEOUT_MS
  );
});

describe("getTraceDetailedSubtreeSummary insertedAtEnd bound", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  clickhouseTest(
    "bounds full and descendant fetches by insertedAtEnd but not ancestor fetches",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "warn",
      });
      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        maximumTraceDetailedSummaryViewCount: TRACE_ROW_LIMIT,
      });

      const environmentId = "env_trace_bound";
      const baseMs = Date.now() - 30 * DAY_MS;
      const expiresAt = convertDateToClickhouseDateTime(new Date(baseMs + 400 * DAY_MS));

      function row(
        traceId: string,
        spanId: string,
        parentSpanId: string,
        startOffsetMs: number,
        insertedOffsetMs: number,
        status: string
      ): TaskEventV2Input {
        return {
          environment_id: environmentId,
          organization_id: "org_trace_bound",
          project_id: "proj_trace_bound",
          task_identifier: "trace-bound-test-task",
          run_id: `run_${spanId}`,
          start_time: formatClickhouseStartTime(baseMs, startOffsetMs),
          inserted_at: convertDateToClickhouseDateTime(new Date(baseMs + insertedOffsetMs)),
          duration: "1000000000",
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          message: spanId,
          kind: "SPAN",
          status,
          attributes: {},
          metadata: "{}",
          expires_at: expiresAt,
        };
      }

      // Full fetch: the requested run is the trace root and completes at +10s.
      const fullTrace = "c".repeat(32);
      const fullCompletedMs = 10_000;
      // Subtree walk: the requested run starts after its parent, so the full fetch can't re-root.
      const walkTrace = "d".repeat(32);
      const walkCreatedMs = 100_000;
      const walkCompletedMs = 110_000;
      // Ancestor: the parent's cancellation is stored long after the bound.
      const ancestorTrace = "e".repeat(32);

      const [insertError] = await clickhouse.taskEventsV2.insert(
        [
          row(fullTrace, "fullroot", "", 0, 0, "PARTIAL"),
          row(fullTrace, "fullroot", "", 0, fullCompletedMs, "OK"),
          row(fullTrace, "fullinside", "fullroot", 1_000, 1_000, "PARTIAL"),
          row(fullTrace, "fullinside", "fullroot", 1_000, fullCompletedMs + 6 * DAY_MS, "OK"),
          row(fullTrace, "fulllate", "fullroot", 2_000, 2_000, "PARTIAL"),
          row(fullTrace, "fulllate", "fullroot", 2_000, fullCompletedMs + 8 * DAY_MS, "OK"),

          row(walkTrace, "walkroot", "", 0, 0, "PARTIAL"),
          row(walkTrace, "walkanchor", "walkroot", walkCreatedMs, walkCreatedMs, "PARTIAL"),
          row(walkTrace, "walkanchor", "walkroot", walkCreatedMs, walkCompletedMs, "OK"),
          row(
            walkTrace,
            "walkinside",
            "walkanchor",
            walkCreatedMs + 1_000,
            walkCreatedMs + 1_000,
            "PARTIAL"
          ),
          row(
            walkTrace,
            "walkinside",
            "walkanchor",
            walkCreatedMs + 1_000,
            walkCompletedMs + DAY_MS,
            "OK"
          ),
          row(
            walkTrace,
            "walklate",
            "walkanchor",
            walkCreatedMs + 2_000,
            walkCreatedMs + 2_000,
            "PARTIAL"
          ),
          row(
            walkTrace,
            "walklate",
            "walkanchor",
            walkCreatedMs + 2_000,
            walkCompletedMs + 9 * DAY_MS,
            "OK"
          ),

          row(ancestorTrace, "ancroot", "", 0, 0, "PARTIAL"),
          row(ancestorTrace, "ancroot", "", 0, 20 * DAY_MS, "CANCELLED"),
          row(ancestorTrace, "ancanchor", "ancroot", walkCreatedMs, walkCreatedMs, "PARTIAL"),
        ],
        { clickhouse_settings: { async_insert: 0 } }
      );
      expect(insertError).toBeNull();

      const fullCompletedAt = new Date(baseMs + fullCompletedMs);
      const fullBounded = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        fullTrace,
        "fullroot",
        new Date(baseMs),
        fullCompletedAt,
        { insertedAtEnd: new Date(fullCompletedAt.getTime() + 7 * DAY_MS) }
      );
      expect(findSpan(fullBounded?.rootSpan, "fullinside")?.data.isPartial).toBe(false);
      expect(findSpan(fullBounded?.rootSpan, "fulllate")?.data.isPartial).toBe(true);

      const fullUnbounded = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        fullTrace,
        "fullroot",
        new Date(baseMs),
        fullCompletedAt
      );
      expect(findSpan(fullUnbounded?.rootSpan, "fullinside")?.data.isPartial).toBe(false);
      expect(findSpan(fullUnbounded?.rootSpan, "fulllate")?.data.isPartial).toBe(false);

      const walkCompletedAt = new Date(baseMs + walkCompletedMs);
      const walk = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        walkTrace,
        "walkanchor",
        new Date(baseMs + walkCreatedMs),
        walkCompletedAt,
        { insertedAtEnd: new Date(walkCompletedAt.getTime() + 7 * DAY_MS) }
      );
      expect(walk?.rootSpan.id).toBe("walkanchor");
      expect(walk?.rootSpan.parentId).toBe("walkroot");
      expect(findSpan(walk?.rootSpan, "walkinside")?.data.isPartial).toBe(false);
      expect(findSpan(walk?.rootSpan, "walklate")?.data.isPartial).toBe(true);

      const ancestor = await repository.getTraceDetailedSubtreeSummary(
        "taskEvent",
        environmentId,
        ancestorTrace,
        "ancanchor",
        new Date(baseMs + walkCreatedMs),
        undefined,
        { insertedAtEnd: new Date(baseMs + 7 * DAY_MS) }
      );
      expect(ancestor?.rootSpan.id).toBe("ancanchor");
      expect(ancestor?.rootSpan.data.isCancelled).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS
  );
});

describe("getTraceDetailedSubtreeSummary ancestor walk", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const environmentId = "env_ancestor_walk";
  const baseMs = Date.now() - 30 * DAY_MS;
  const anchorCreatedMs = 100_000;
  const expiresAt = convertDateToClickhouseDateTime(new Date(baseMs + 400 * DAY_MS));

  function row(
    traceId: string,
    spanId: string,
    parentSpanId: string,
    startOffsetMs: number,
    insertedOffsetMs: number,
    status: string
  ): TaskEventV2Input {
    return {
      environment_id: environmentId,
      organization_id: "org_ancestor_walk",
      project_id: "proj_ancestor_walk",
      task_identifier: "ancestor-walk-test-task",
      run_id: `run_${spanId}`,
      start_time: formatClickhouseStartTime(baseMs, startOffsetMs),
      inserted_at: convertDateToClickhouseDateTime(new Date(baseMs + insertedOffsetMs)),
      duration: "1000000000",
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      message: spanId,
      kind: "SPAN",
      status,
      attributes: {},
      metadata: "{}",
      expires_at: expiresAt,
    };
  }

  // A child run whose parent span starts before the child's window, under a top span.
  function childRunRows(traceId: string, anchorStatus: string): TaskEventV2Input[] {
    return [
      row(traceId, "top", "", 0, 0, "PARTIAL"),
      row(traceId, "parent", "top", 1_000, 1_000, "PARTIAL"),
      row(traceId, "anchor", "parent", anchorCreatedMs, anchorCreatedMs, "PARTIAL"),
      ...(anchorStatus === "PARTIAL"
        ? []
        : [
            row(
              traceId,
              "anchor",
              "parent",
              anchorCreatedMs,
              anchorCreatedMs + 10_000,
              anchorStatus
            ),
          ]),
      row(
        traceId,
        "anchorchild",
        "anchor",
        anchorCreatedMs + 1_000,
        anchorCreatedMs + 1_000,
        "PARTIAL"
      ),
    ];
  }

  const closedTrace = "1".repeat(32);
  const truncatedTrace = "2".repeat(32);
  const cancelledParentTrace = "3".repeat(32);
  const boundTrace = "4".repeat(32);

  const traceRows: TaskEventV2Input[] = [
    ...childRunRows(closedTrace, "OK"),
    // Enough children to truncate the full read, so the subtree walk runs.
    ...childRunRows(truncatedTrace, "OK"),
    ...Array.from({ length: TRACE_ROW_LIMIT + 10 }, (_, index) =>
      row(
        truncatedTrace,
        `filler${String(index).padStart(4, "0")}`,
        "anchor",
        anchorCreatedMs + 2_000 + index,
        anchorCreatedMs + 2_000 + index,
        "OK"
      )
    ),
    ...childRunRows(cancelledParentTrace, "PARTIAL"),
    row(cancelledParentTrace, "parent", "top", 1_000, 50 * 1_000, "CANCELLED"),
    // The parent's only rows are stored before the ancestor lower bound.
    row(boundTrace, "parent", "", 1_000, 1_000, "PARTIAL"),
    row(boundTrace, "parent", "", 1_000, 2_000, "CANCELLED"),
    row(boundTrace, "anchor", "parent", anchorCreatedMs, anchorCreatedMs, "PARTIAL"),
  ];

  function setup(clickhouse: ClickHouse) {
    return new ClickhouseEventRepository({
      clickhouse,
      version: "v2",
      maximumTraceDetailedSummaryViewCount: TRACE_ROW_LIMIT,
    });
  }

  async function insertRows(clickhouse: ClickHouse) {
    const [insertError] = await clickhouse.taskEventsV2.insert(traceRows, {
      clickhouse_settings: { async_insert: 0 },
    });
    expect(insertError).toBeNull();
  }

  clickhouseTest(
    "skips, re-roots, stops early and bounds the ancestor walk",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "warn",
      });
      const repository = setup(clickhouse);
      await insertRows(clickhouse);
      const tracing = createInMemoryTracing();

      const anchorCreatedAt = new Date(baseMs + anchorCreatedMs);
      const anchorCompletedAt = new Date(baseMs + anchorCreatedMs + 10_000);

      const subtree = (
        traceId: string,
        options: { completed?: boolean; ancestorInsertedAtStart?: Date } = {}
      ) =>
        tracing.tracer.startActiveSpan(`load ${traceId}`, async (span) => {
          try {
            return await repository.getTraceDetailedSubtreeSummary(
              "taskEvent",
              environmentId,
              traceId,
              "anchor",
              anchorCreatedAt,
              options.completed ? anchorCompletedAt : undefined,
              {
                insertedAtEnd: options.completed
                  ? new Date(anchorCompletedAt.getTime() + 7 * DAY_MS)
                  : undefined,
                ancestorInsertedAtStart: options.ancestorInsertedAtStart,
              }
            );
          } finally {
            span.end();
          }
        });

      const spanAttributes = (traceId: string) =>
        tracing.exporter.getFinishedSpans().find((span) => span.name === `load ${traceId}`)
          ?.attributes;

      // Completed anchor, parent outside the full read: one query, no walk.
      const closed = await subtree(closedTrace, { completed: true });
      expect(closed?.rootSpan.id).toBe("anchor");
      expect(closed?.rootSpan.parentId).toBe("parent");
      expect(closed?.rootSpan.data.isPartial).toBe(false);
      expect(closed?.rootSpan.children.map((child) => child.id)).toEqual(["anchorchild"]);
      expect(spanAttributes(closedTrace)).toMatchObject({
        "trace.ancestor_walk": "fast_path",
        "trace.ancestor_hops": 0,
      });

      // Completed anchor, truncated full read: the walk runs but reads no ancestors.
      const truncated = await subtree(truncatedTrace, { completed: true });
      expect(truncated?.rootSpan.id).toBe("anchor");
      expect(truncated?.rootSpan.data.isPartial).toBe(false);
      expect(spanAttributes(truncatedTrace)).toMatchObject({
        "trace.ancestor_walk": "skipped_closed",
        "trace.ancestor_hops": 0,
      });

      // Open anchor under a cancelled parent: cancelled, and nothing above the parent is read.
      const cancelled = await subtree(cancelledParentTrace);
      expect(cancelled?.rootSpan.id).toBe("anchor");
      expect(cancelled?.rootSpan.data.isCancelled).toBe(true);
      expect(findSpan(cancelled?.rootSpan, "anchorchild")?.data.isCancelled).toBe(true);
      expect(spanAttributes(cancelledParentTrace)).toMatchObject({
        "trace.ancestor_walk": "walked",
        "trace.ancestor_hops": 1,
      });

      // Ancestor rows stored before the lower bound aren't read.
      const unbounded = await subtree(boundTrace);
      expect(unbounded?.rootSpan.data.isCancelled).toBe(true);
      const bounded = await subtree(boundTrace, {
        ancestorInsertedAtStart: new Date(baseMs + 3_000),
      });
      expect(bounded?.rootSpan.id).toBe("anchor");
      expect(bounded?.rootSpan.data.isPartial).toBe(true);
      expect(bounded?.rootSpan.data.isCancelled).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS
  );

  clickhouseTest(
    "returns the subtree without overrides when an ancestor read fails",
    async ({ clickhouseContainer }) => {
      // Rejects reads with no inserted_at (partition key) filter: only the unbounded ancestor read.
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        logLevel: "warn",
        clickhouseSettings: { force_index_by_date: 1 },
      });
      const repository = setup(clickhouse);
      await insertRows(clickhouse);
      const tracing = createInMemoryTracing();

      const subtree = await tracing.tracer.startActiveSpan("load failing", async (span) => {
        try {
          return await repository.getTraceDetailedSubtreeSummary(
            "taskEvent",
            environmentId,
            cancelledParentTrace,
            "anchor",
            new Date(baseMs + anchorCreatedMs)
          );
        } finally {
          span.end();
        }
      });

      expect(subtree?.rootSpan.id).toBe("anchor");
      expect(subtree?.rootSpan.data.isPartial).toBe(true);
      expect(subtree?.rootSpan.data.isCancelled).toBe(false);
      expect(subtree?.rootSpan.children.map((child) => child.id)).toEqual(["anchorchild"]);
      expect(
        tracing.exporter.getFinishedSpans().find((span) => span.name === "load failing")?.attributes
      ).toMatchObject({ "trace.ancestor_walk": "failed", "trace.ancestor_hops": 1 });
    },
    INTEGRATION_TIMEOUT_MS
  );
});
