import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import type { SpanDetailedSummary } from "~/v3/eventRepository/eventRepository.types";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";

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
