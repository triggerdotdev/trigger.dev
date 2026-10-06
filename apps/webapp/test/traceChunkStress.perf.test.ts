import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";
import { TraceChunkAssembler } from "~/v3/eventRepository/traceChunkAssembler";
import { applyAncestorOverrides, buildTraceView } from "~/v3/eventRepository/traceViewBuilder";

const ENV_ID = "env_stress";
const ORG_ID = "org_stress";
const PROJECT_ID = "project_stress";
const BASE = new Date("2026-09-01T10:00:00.000Z");

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type NodeSpec = {
  spanId: string;
  parentSpanId: string;
  traceId: string;
  offsetMs: number;
  kind: string;
  status: string;
  durationNs: number;
  message: string;
  metadata?: string;
  runId?: string;
  multiRow?: boolean;
};

function row(node: NodeSpec, status = node.status, durationNs = node.durationNs): TaskEventV2Input {
  return {
    environment_id: ENV_ID,
    organization_id: ORG_ID,
    project_id: PROJECT_ID,
    task_identifier: "stress-task",
    run_id: node.runId ?? `run_${node.traceId}`,
    start_time: clickhouseDate(new Date(BASE.getTime() + node.offsetMs)),
    duration: String(durationNs),
    trace_id: node.traceId,
    span_id: node.spanId,
    parent_span_id: node.parentSpanId,
    message: node.message,
    kind: node.kind,
    status,
    attributes: {},
    metadata: node.metadata ?? "{}",
    expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
  };
}

function rowsFor(nodes: NodeSpec[]): TaskEventV2Input[] {
  const rows: TaskEventV2Input[] = [];
  for (const node of nodes) {
    if (node.multiRow) {
      rows.push(row(node, "PARTIAL", 0));
      rows.push(row(node, node.status, node.durationNs));
    } else {
      rows.push(row(node));
    }
  }
  return rows;
}

type Shape = "chain" | "wide" | "balanced" | "random";

function generateTrace(opts: {
  traceId: string;
  count: number;
  shape: Shape;
  seed?: number;
  distinctTimestamps?: boolean;
  logRatio?: number;
  multiRowRatio?: number;
  errorIndices?: number[];
}): { nodes: NodeSpec[]; rootSpanId: string } {
  const { traceId, count, shape, seed = 1, distinctTimestamps = true } = opts;
  const rand = mulberry32(seed);
  const logRatio = opts.logRatio ?? 0.2;
  const multiRowRatio = opts.multiRowRatio ?? 0.15;
  const errorIndices = new Set(opts.errorIndices ?? []);

  const nodes: NodeSpec[] = [];
  const rootSpanId = `${traceId}_s0`;

  for (let i = 0; i < count; i++) {
    const spanId = `${traceId}_s${i}`;
    let parentSpanId = "";
    if (i > 0) {
      switch (shape) {
        case "chain":
          parentSpanId = `${traceId}_s${i - 1}`;
          break;
        case "wide":
          parentSpanId = rootSpanId;
          break;
        case "balanced":
          parentSpanId = `${traceId}_s${Math.floor((i - 1) / 2)}`;
          break;
        case "random":
          parentSpanId = `${traceId}_s${Math.floor(rand() * i)}`;
          break;
      }
    }

    const isError = errorIndices.has(i);
    const isLog = !isError && i > 0 && rand() < logRatio;
    const offsetMs = distinctTimestamps ? i * 5 : Math.floor(i / 3) * 5;

    nodes.push({
      spanId,
      parentSpanId,
      traceId,
      offsetMs,
      kind: isLog ? "LOG_INFO" : "SPAN",
      status: isError ? "ERROR" : "OK",
      durationNs: isLog ? 0 : (count - i) * 1_000_000,
      message: `span-${i}`,
      multiRow: !isLog && !isError && rand() < multiRowRatio,
    });
  }

  return { nodes, rootSpanId };
}

function makeRepo(clickhouse: ClickHouse) {
  return new ClickhouseEventRepository({ clickhouse, version: "v2", insertStrategy: "insert" });
}

async function shutdown(repository: ClickhouseEventRepository) {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

const START = new Date(BASE.getTime() - 60_000);
const END = new Date(BASE.getTime() + 3_600_000);

async function assembleProgressive(
  repository: ClickhouseEventRepository,
  traceId: string,
  chunkSize: number
): Promise<{ assembler: TraceChunkAssembler; chunkCount: number; totalEvents: number }> {
  const assembler = new TraceChunkAssembler();
  let cursor: TraceChunkCursor | undefined = undefined;
  let chunkCount = 0;
  let totalEvents = 0;
  let guard = 0;
  while (true) {
    if (++guard > 1_000_000) throw new Error("pagination did not terminate");
    const chunk = await repository.getTraceChunk(
      "taskEventPartitioned",
      ENV_ID,
      traceId,
      START,
      END,
      cursor,
      { includeDebugLogs: true, limit: chunkSize }
    );
    if (!chunk) throw new Error("no chunk");
    chunkCount++;
    totalEvents += chunk.events.length;
    assembler.mergeChunk(chunk.events);
    if (!chunk.hasMore) break;
    cursor = chunk.nextCursor ?? undefined;
  }
  return { assembler, chunkCount, totalEvents };
}

async function assembleFirstNChunks(
  repository: ClickhouseEventRepository,
  traceId: string,
  chunkSize: number,
  n: number
): Promise<TraceChunkAssembler> {
  const assembler = new TraceChunkAssembler();
  let cursor: TraceChunkCursor | undefined = undefined;
  for (let i = 0; i < n; i++) {
    const chunk = await repository.getTraceChunk(
      "taskEventPartitioned",
      ENV_ID,
      traceId,
      START,
      END,
      cursor,
      { includeDebugLogs: true, limit: chunkSize }
    );
    if (!chunk) throw new Error("no chunk");
    assembler.mergeChunk(chunk.events);
    if (!chunk.hasMore) break;
    cursor = chunk.nextCursor ?? undefined;
  }
  return assembler;
}

function errorsOnlyVisible(events: ReturnType<typeof buildTraceView>["events"]): Set<string> {
  const byId = new Map(events.map((e) => [e.id, e]));
  const childrenByParent = new Map<string, string[]>();
  for (const e of events) {
    if (e.parentId) {
      const arr = childrenByParent.get(e.parentId) ?? [];
      arr.push(e.id);
      childrenByParent.set(e.parentId, arr);
    }
  }
  const visible = new Set<string>();
  for (const e of events) {
    if (!e.data.isError) continue;
    visible.add(e.id);
    let parentId = e.parentId;
    while (parentId && byId.has(parentId)) {
      visible.add(parentId);
      parentId = byId.get(parentId)!.parentId;
    }
    for (const child of childrenByParent.get(e.id) ?? []) {
      visible.add(child);
    }
  }
  return visible;
}

const BUILD_OPTIONS = {
  runFriendlyId: "run_x",
  isAgentRun: false,
  isAdmin: true,
};

describe("trace chunk stress — progressive == single-request", () => {
  const shapes: Shape[] = ["chain", "wide", "balanced", "random"];
  const chunkSizes = [1, 2, 3, 7, 50];

  for (const shape of shapes) {
    clickhouseTest(
      `progressive assembly equals the full getTraceSummary load (${shape})`,
      async ({ clickhouseContainer }) => {
        const clickhouse = new ClickHouse({
          url: clickhouseContainer.getConnectionUrl(),
          name: "test",
        });
        const repository = makeRepo(clickhouse);
        try {
          const traceId = `tr_${shape}`;
          const { nodes, rootSpanId } = generateTrace({
            traceId,
            count: 120,
            shape,
            seed: 42,
            distinctTimestamps: true,
          });
          const [err] = await clickhouse.taskEventsV2.insert(rowsFor(nodes));
          expect(err).toBeNull();

          const summary = await repository.getTraceSummary(
            "taskEventPartitioned",
            ENV_ID,
            traceId,
            START,
            END,
            { includeDebugLogs: true }
          );
          expect(summary).toBeDefined();
          const referenceView = buildTraceView(summary!.spans, {
            ...BUILD_OPTIONS,
            rootSpanId,
          });

          for (const chunkSize of chunkSizes) {
            const { assembler } = await assembleProgressive(repository, traceId, chunkSize);
            const { spans } = applyAncestorOverrides(assembler.spans);
            const view = buildTraceView(spans, { ...BUILD_OPTIONS, rootSpanId });

            expect(
              view.events.map((e) => e.id),
              `ids @ chunkSize=${chunkSize}`
            ).toEqual(referenceView.events.map((e) => e.id));
            expect(view.events, `events @ chunkSize=${chunkSize}`).toEqual(referenceView.events);
            expect(view.duration).toEqual(referenceView.duration);
            expect(view.rootSpanStatus).toEqual(referenceView.rootSpanStatus);
          }
        } finally {
          await shutdown(repository);
        }
      },
      60_000
    );
  }
});

describe("trace chunk stress — invariance, overrides, scale, and cap", () => {
  clickhouseTest(
    "equal-timestamp spans + multi-row spans: chunk size doesn't change the tree, and no gaps/duplicates",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = makeRepo(clickhouse);
      try {
        const traceId = "tr_equalts";
        const { nodes, rootSpanId } = generateTrace({
          traceId,
          count: 200,
          shape: "random",
          seed: 7,
          distinctTimestamps: false,
          multiRowRatio: 0.4,
          logRatio: 0.25,
        });
        const [err] = await clickhouse.taskEventsV2.insert(rowsFor(nodes));
        expect(err).toBeNull();

        const single = await assembleProgressive(repository, traceId, 100_000);
        const singleIds = buildTraceView(applyAncestorOverrides(single.assembler.spans).spans, {
          ...BUILD_OPTIONS,
          rootSpanId,
        }).events.map((e) => e.id);

        expect(single.assembler.size, "distinct spans").toBe(200);

        for (const chunkSize of [1, 2, 5, 13, 64]) {
          const paged = await assembleProgressive(repository, traceId, chunkSize);
          expect(paged.assembler.size, `distinct spans @ ${chunkSize}`).toBe(200);
          const ids = buildTraceView(applyAncestorOverrides(paged.assembler.spans).spans, {
            ...BUILD_OPTIONS,
            rootSpanId,
          }).events.map((e) => e.id);
          expect(ids, `flatten order @ chunkSize=${chunkSize}`).toEqual(singleIds);
        }
      } finally {
        await shutdown(repository);
      }
    },
    60_000
  );

  clickhouseTest(
    "ancestor overrides (cancelled + errored attempt) propagate identically under chunking",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = makeRepo(clickhouse);
      try {
        const traceId = "tr_overrides";
        const rows: TaskEventV2Input[] = [];
        const mk = (
          spanId: string,
          parent: string,
          offsetMs: number,
          kind: string,
          status: string,
          durationNs: number,
          message: string,
          metadata = "{}"
        ) =>
          rows.push(
            row(
              {
                spanId,
                parentSpanId: parent,
                traceId,
                offsetMs,
                kind,
                status,
                durationNs,
                message,
                metadata,
              },
              status,
              durationNs
            )
          );

        mk("ov_root", "", 0, "SPAN", "OK", 200_000_000, "root");

        mk("ov_cancel", "ov_root", 10, "SPAN", "CANCELLED", 50_000_000, "cancelled-parent");
        mk(
          "ov_cancel",
          "ov_root",
          10,
          "SPAN_EVENT",
          "OK",
          0,
          "cancellation",
          JSON.stringify({ reason: "user cancelled" })
        );
        mk("ov_cancel_child", "ov_cancel", 20, "SPAN", "PARTIAL", 0, "partial-descendant");

        mk("ov_err", "ov_root", 30, "SPAN", "ERROR", 40_000_000, "errored-parent");
        mk(
          "ov_err",
          "ov_root",
          30,
          "SPAN_EVENT",
          "OK",
          0,
          "attempt_failed",
          JSON.stringify({
            attemptNumber: 1,
            runId: "run_ov_err_child",
            exception: { message: "boom", type: "Error" },
          })
        );
        mk(
          "ov_err_child",
          "ov_err",
          40,
          "SPAN",
          "PARTIAL",
          0,
          "partial-attempt",
          JSON.stringify({ attemptNumber: 1 })
        );
        rows[rows.length - 1].run_id = "run_ov_err_child";

        const [err] = await clickhouse.taskEventsV2.insert(rows);
        expect(err).toBeNull();

        const summary = await repository.getTraceSummary(
          "taskEventPartitioned",
          ENV_ID,
          traceId,
          START,
          END,
          { includeDebugLogs: true }
        );
        const referenceView = buildTraceView(summary!.spans, {
          ...BUILD_OPTIONS,
          rootSpanId: "ov_root",
        });
        const referenceOverrides = summary!.overridesBySpanId ?? {};

        for (const chunkSize of [1, 2, 3, 100]) {
          const { assembler } = await assembleProgressive(repository, traceId, chunkSize);
          const { spans, overridesBySpanId } = applyAncestorOverrides(assembler.spans);
          const view = buildTraceView(spans, { ...BUILD_OPTIONS, rootSpanId: "ov_root" });

          expect(view.events, `events @ ${chunkSize}`).toEqual(referenceView.events);
          expect(overridesBySpanId, `overrides @ ${chunkSize}`).toEqual(referenceOverrides);
        }

        expect(referenceOverrides["ov_cancel_child"]?.isCancelled).toBe(true);
        expect(referenceOverrides["ov_err_child"]?.isError).toBe(true);
      } finally {
        await shutdown(repository);
      }
    },
    60_000
  );

  clickhouseTest(
    "large trace (8k spans) assembles progressively and matches the single-request load",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = makeRepo(clickhouse);
      try {
        const traceId = "tr_large";
        const { nodes, rootSpanId } = generateTrace({
          traceId,
          count: 8_000,
          shape: "random",
          seed: 99,
          distinctTimestamps: true,
          multiRowRatio: 0.2,
        });
        const [err] = await clickhouse.taskEventsV2.insert(rowsFor(nodes));
        expect(err).toBeNull();

        const summary = await repository.getTraceSummary(
          "taskEventPartitioned",
          ENV_ID,
          traceId,
          START,
          END,
          { includeDebugLogs: true }
        );
        const referenceView = buildTraceView(summary!.spans, {
          ...BUILD_OPTIONS,
          rootSpanId,
        });

        const t0 = performance.now();
        const { assembler, chunkCount } = await assembleProgressive(repository, traceId, 2000);
        const elapsedMs = performance.now() - t0;

        const view = buildTraceView(applyAncestorOverrides(assembler.spans).spans, {
          ...BUILD_OPTIONS,
          rootSpanId,
        });

        expect(assembler.size).toBe(8_000);
        expect(view.events.map((e) => e.id)).toEqual(referenceView.events.map((e) => e.id));
        // eslint-disable-next-line no-console
        console.log(
          `[stress] 8k spans: ${chunkCount} chunks, progressive fetch ${elapsedMs.toFixed(0)}ms`
        );
      } finally {
        await shutdown(repository);
      }
    },
    120_000
  );

  clickhouseTest(
    "a trace larger than the summary cap loads fully via chunks (no truncation)",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        insertStrategy: "insert",
        maximumTraceSummaryViewCount: 100,
      });
      try {
        const traceId = "tr_overcap";
        const { nodes } = generateTrace({
          traceId,
          count: 400,
          shape: "wide",
          seed: 3,
          distinctTimestamps: true,
          multiRowRatio: 0,
          logRatio: 0,
        });
        const [err] = await clickhouse.taskEventsV2.insert(rowsFor(nodes));
        expect(err).toBeNull();

        const summary = await repository.getTraceSummary(
          "taskEventPartitioned",
          ENV_ID,
          traceId,
          START,
          END,
          { includeDebugLogs: true }
        );
        expect(summary!.isTruncated).toBe(true);
        expect(summary!.spans.length).toBeLessThanOrEqual(100);

        const { assembler } = await assembleProgressive(repository, traceId, 50);
        expect(assembler.size).toBe(400);
      } finally {
        await shutdown(repository);
      }
    },
    60_000
  );
});

describe("trace chunk stress — errors-only and search are complete/correct mid-load", () => {
  clickhouseTest(
    "errors-only shows the complete set (errors + ancestors + direct children) at every load stage",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = makeRepo(clickhouse);
      try {
        const traceId = "tr_errmid";
        const errorIndices = [10, 50, 200];
        const { nodes, rootSpanId } = generateTrace({
          traceId,
          count: 600,
          shape: "balanced",
          seed: 5,
          distinctTimestamps: true,
          logRatio: 0.15,
          multiRowRatio: 0.1,
          errorIndices,
        });
        const [err] = await clickhouse.taskEventsV2.insert(rowsFor(nodes));
        expect(err).toBeNull();

        const full = await assembleProgressive(repository, traceId, 25);
        const fullView = buildTraceView(applyAncestorOverrides(full.assembler.spans).spans, {
          ...BUILD_OPTIONS,
          rootSpanId,
        });
        const reference = errorsOnlyVisible(fullView.events);
        for (const i of errorIndices) {
          expect(reference.has(`${traceId}_s${i}`)).toBe(true);
          expect(reference.has(`${traceId}_s${2 * i + 1}`)).toBe(true);
        }

        const errorEvents = await repository.getTraceErrorEvents(
          "taskEventPartitioned",
          ENV_ID,
          traceId,
          START,
          END,
          { includeDebugLogs: true }
        );
        expect(errorEvents).toBeDefined();

        for (const n of [1, 2, 5, 10, 24]) {
          const assembler = await assembleFirstNChunks(repository, traceId, 25, n);
          assembler.mergeChunk(
            errorEvents!.map((e) => ({ ...e, startTime: new Date(e.startTime) }))
          );
          const view = buildTraceView(applyAncestorOverrides(assembler.spans).spans, {
            ...BUILD_OPTIONS,
            rootSpanId,
          });
          const midVisible = errorsOnlyVisible(view.events);
          expect(midVisible, `errors-only visible set after ${n} chunk(s)`).toEqual(reference);
        }
      } finally {
        await shutdown(repository);
      }
    },
    120_000
  );

  clickhouseTest(
    "client search over loaded events grows monotonically and converges to complete",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = makeRepo(clickhouse);
      try {
        const traceId = "tr_searchmid";
        const { nodes, rootSpanId } = generateTrace({
          traceId,
          count: 300,
          shape: "balanced",
          seed: 8,
          distinctTimestamps: true,
          logRatio: 0,
          multiRowRatio: 0,
        });
        const [err] = await clickhouse.taskEventsV2.insert(rowsFor(nodes));
        expect(err).toBeNull();

        const query = "span-5";
        const matchesIn = (events: ReturnType<typeof buildTraceView>["events"]) =>
          new Set(
            events.filter((e) => e.data.message.toLowerCase().includes(query)).map((e) => e.id)
          );

        const full = await assembleProgressive(repository, traceId, 20);
        const fullView = buildTraceView(applyAncestorOverrides(full.assembler.spans).spans, {
          ...BUILD_OPTIONS,
          rootSpanId,
        });
        const finalMatches = matchesIn(fullView.events);
        expect(finalMatches.size).toBeGreaterThan(1);

        let previousSize = 0;
        let previous = new Set<string>();
        for (let n = 1; n <= full.chunkCount; n++) {
          const assembler = await assembleFirstNChunks(repository, traceId, 20, n);
          const view = buildTraceView(applyAncestorOverrides(assembler.spans).spans, {
            ...BUILD_OPTIONS,
            rootSpanId,
          });
          const matches = matchesIn(view.events);
          for (const id of previous) {
            expect(matches.has(id), `match ${id} must persist as chunks load`).toBe(true);
          }
          expect(matches.size).toBeGreaterThanOrEqual(previousSize);
          previousSize = matches.size;
          previous = matches;
        }
        expect(previous).toEqual(finalMatches);
      } finally {
        await shutdown(repository);
      }
    },
    120_000
  );
});

describe("trace chunk stress — errors-only includes override-propagated (failed-attempt) errors", () => {
  clickhouseTest(
    "a still-partial descendant of a failed-attempt run is in the errors-only set at every load stage",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = makeRepo(clickhouse);
      try {
        const traceId = "tr_override";
        const rootId = `${traceId}_s0`;
        const runR = `${traceId}_runR`;
        const childC = `${traceId}_childC`;

        const filler = generateTrace({
          traceId,
          count: 120,
          shape: "balanced",
          seed: 3,
          distinctTimestamps: true,
          logRatio: 0,
          multiRowRatio: 0,
        }).nodes;

        const overrideNodes: NodeSpec[] = [
          {
            spanId: runR,
            parentSpanId: rootId,
            traceId,
            offsetMs: 5000,
            kind: "SPAN",
            status: "ERROR",
            durationNs: 50_000_000,
            message: "errored-run",
            runId: "runR",
          },
          {
            spanId: runR,
            parentSpanId: rootId,
            traceId,
            offsetMs: 5000,
            kind: "ANCESTOR_OVERRIDE",
            status: "OK",
            durationNs: 0,
            message: "attempt_failed",
            runId: "runR",
            metadata: JSON.stringify({
              attemptNumber: 1,
              runId: "runR",
              exception: { message: "boom" },
            }),
          },
          {
            spanId: childC,
            parentSpanId: runR,
            traceId,
            offsetMs: 5010,
            kind: "SPAN",
            status: "PARTIAL",
            durationNs: 0,
            message: "partial-attempt",
            runId: "runR",
            metadata: JSON.stringify({ attemptNumber: 1 }),
          },
        ];

        const [err] = await clickhouse.taskEventsV2.insert(rowsFor([...filler, ...overrideNodes]));
        expect(err).toBeNull();

        const full = await assembleProgressive(repository, traceId, 25);
        const fullView = buildTraceView(applyAncestorOverrides(full.assembler.spans).spans, {
          ...BUILD_OPTIONS,
          rootSpanId: rootId,
        });
        const childCEvent = fullView.events.find((e) => e.id === childC);
        expect(childCEvent?.data.isError, "override marks the partial descendant as error").toBe(
          true
        );

        const reference = errorsOnlyVisible(fullView.events);
        expect(reference).toEqual(new Set([rootId, runR, childC]));

        const errorEvents = await repository.getTraceErrorEvents(
          "taskEventPartitioned",
          ENV_ID,
          traceId,
          START,
          END,
          { includeDebugLogs: true }
        );
        const fetchedIds = new Set(errorEvents!.map((e) => e.spanId));
        expect(fetchedIds.has(childC), "getTraceErrorEvents includes the override-error").toBe(
          true
        );
        expect(fetchedIds.has(runR)).toBe(true);

        for (const n of [1, 2, 3]) {
          const assembler = await assembleFirstNChunks(repository, traceId, 25, n);
          if (n <= 2) {
            expect(assembler.hasSpan(childC), `childC not loaded at ${n} chunks`).toBe(false);
          }
          assembler.mergeChunk(
            errorEvents!.map((e) => ({ ...e, startTime: new Date(e.startTime) }))
          );
          const view = buildTraceView(applyAncestorOverrides(assembler.spans).spans, {
            ...BUILD_OPTIONS,
            rootSpanId: rootId,
          });
          expect(
            errorsOnlyVisible(view.events),
            `override-error visible after ${n} chunk(s)`
          ).toEqual(reference);
        }
      } finally {
        await shutdown(repository);
      }
    },
    120_000
  );
});
