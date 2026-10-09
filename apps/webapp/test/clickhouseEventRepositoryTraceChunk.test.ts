import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";

vi.setConfig({ testTimeout: 60_000 });

const TRACE_ID = "trace_chunk_test";
const ENV_ID = "env_chunk_test";
const BASE = new Date("2026-09-01T10:00:00.000Z");

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function event(
  spanId: string,
  offsetMs: number,
  message: string,
  parentSpanId: string
): TaskEventV2Input {
  return {
    environment_id: ENV_ID,
    organization_id: "org_chunk_test",
    project_id: "project_chunk_test",
    task_identifier: "chunk-task",
    run_id: "run_chunk_test",
    start_time: clickhouseDate(new Date(BASE.getTime() + offsetMs)),
    duration: "1000000",
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: parentSpanId,
    message,
    kind: "SPAN",
    status: "OK",
    attributes: {},
    metadata: "{}",
    expires_at: clickhouseDate(new Date(Date.now() + 86_400_000)),
  };
}

const EVENTS: TaskEventV2Input[] = [
  event("a", 0, "a", ""),
  event("b", 10, "b", "a"),
  event("c", 10, "c", "a"),
  event("d", 20, "d-partial", "b"),
  event("d", 20, "d-complete", "b"),
  event("e", 30, "e", "b"),
  event("f", 40, "f", "c"),
];

async function shutdownRepository(repository: ClickhouseEventRepository): Promise<void> {
  await Promise.all([
    (repository as any)._flushScheduler.shutdown(),
    (repository as any)._llmMetricsFlushScheduler.shutdown(),
    (repository as any)._otlpMetricsFlushScheduler.shutdown(),
  ]);
}

async function collectAllChunks(
  repository: ClickhouseEventRepository,
  limit: number
): Promise<string[]> {
  const messages: string[] = [];
  let cursor: TraceChunkCursor | undefined = undefined;
  let iterations = 0;

  while (true) {
    if (++iterations > 100) {
      throw new Error("Trace chunk pagination did not terminate");
    }

    const chunk = await repository.getTraceChunk(
      "taskEventPartitioned",
      ENV_ID,
      TRACE_ID,
      new Date(BASE.getTime() - 60_000),
      new Date(BASE.getTime() + 60_000),
      cursor,
      { includeDebugLogs: true, limit }
    );

    expect(chunk).toBeDefined();
    if (!chunk) break;

    for (const e of chunk.events) {
      messages.push(e.message);
    }

    if (!chunk.hasMore) {
      expect(chunk.nextCursor).toBeNull();
      break;
    }

    expect(chunk.nextCursor).not.toBeNull();
    cursor = chunk.nextCursor ?? undefined;
  }

  return messages;
}

describe("ClickhouseEventRepository getTraceChunk", () => {
  clickhouseTest(
    "pages a trace with no gaps or duplicates across boundaries",
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
        const [insertError] = await clickhouse.taskEventsV2.insert(EVENTS);
        expect(insertError).toBeNull();

        const expected = EVENTS.map((e) => e.message).sort();

        const oneShot = await collectAllChunks(repository, 100);
        expect([...oneShot].sort()).toEqual(expected);
        expect(oneShot).toHaveLength(EVENTS.length);

        const paged = await collectAllChunks(repository, 2);
        expect([...paged].sort()).toEqual(expected);
        expect(new Set(paged).size).toBe(new Set(expected).size);
        expect(paged.filter((m) => m === "d-partial")).toHaveLength(1);
        expect(paged.filter((m) => m === "d-complete")).toHaveLength(1);

        // A page smaller than a span's rows goes through the same-key regroup.
        const single = await collectAllChunks(repository, 1);
        expect([...single].sort()).toEqual(expected);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  clickhouseTest(
    "returns hasMore=false and a null cursor for an empty trace",
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
        const chunk = await repository.getTraceChunk(
          "taskEventPartitioned",
          ENV_ID,
          "trace_does_not_exist",
          new Date(BASE.getTime() - 60_000),
          new Date(BASE.getTime() + 60_000),
          undefined,
          { limit: 10 }
        );

        expect(chunk).toBeDefined();
        expect(chunk?.events).toEqual([]);
        expect(chunk?.hasMore).toBe(false);
        expect(chunk?.nextCursor).toBeNull();
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

describe("ClickhouseEventRepository getTraceChunk same-key regroup", () => {
  clickhouseTest(
    "caps the rows read for one span key and pages past it",
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
        const [insertError] = await clickhouse.taskEventsV2.insert([
          ...Array.from({ length: 10_005 }, (_, i) => event("same", 0, `same-${i}`, "")),
          event("after", 10, "after", "same"),
        ]);
        expect(insertError).toBeNull();

        const fetchPage = (cursor?: TraceChunkCursor) =>
          repository.getTraceChunk(
            "taskEventPartitioned",
            ENV_ID,
            TRACE_ID,
            new Date(BASE.getTime() - 60_000),
            new Date(BASE.getTime() + 60_000),
            cursor,
            { includeDebugLogs: true, limit: 2 }
          );

        const first = await fetchPage();
        expect(first?.events).toHaveLength(10_000);
        expect(first?.events.every((e) => e.spanId === "same")).toBe(true);
        expect(first?.hasMore).toBe(true);

        const second = await fetchPage(first?.nextCursor ?? undefined);
        expect(second?.events.map((e) => e.spanId)).toEqual(["after"]);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

describe("ClickhouseEventRepository getTraceChunk key row cap", () => {
  clickhouseTest(
    "honours a lower key row cap, e.g. from the emergency span cap",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "test",
      });
      const repository = new ClickhouseEventRepository({
        clickhouse,
        version: "v2",
        insertStrategy: "insert",
        maximumKeyRows: 3,
      });

      try {
        const [insertError] = await clickhouse.taskEventsV2.insert([
          ...Array.from({ length: 6 }, (_, i) => event("same", 0, `same-${i}`, "")),
          event("after", 10, "after", "same"),
        ]);
        expect(insertError).toBeNull();

        const fetchPage = (cursor?: TraceChunkCursor) =>
          repository.getTraceChunk(
            "taskEventPartitioned",
            ENV_ID,
            TRACE_ID,
            new Date(BASE.getTime() - 60_000),
            new Date(BASE.getTime() + 60_000),
            cursor,
            { includeDebugLogs: true, limit: 2 }
          );

        const first = await fetchPage();
        expect(first?.events).toHaveLength(3);
        const second = await fetchPage(first?.nextCursor ?? undefined);
        expect(second?.events.map((e) => e.spanId)).toEqual(["after"]);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

describe("ClickhouseEventRepository getTraceChunk live tail", () => {
  clickhouseTest(
    "returns only rows written at or after tailInsertedAtSinceMs",
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

      const earlyWrite = new Date(BASE.getTime() + 1_000);
      const tailSince = new Date(BASE.getTime() + 5 * 60_000);
      const lateWrite = new Date(BASE.getTime() + 10 * 60_000);
      const writtenAt = (e: TaskEventV2Input, at: Date): TaskEventV2Input => ({
        ...e,
        inserted_at: clickhouseDate(at),
      });

      try {
        const [insertError] = await clickhouse.taskEventsV2.insert([
          writtenAt(event("a", 0, "a", ""), earlyWrite),
          writtenAt(event("b", 10, "b-partial", "a"), earlyWrite),
          // A late completion row keeps the span's original start time.
          writtenAt(event("b", 10, "b-complete", "a"), lateWrite),
          writtenAt(event("c", 20, "c", "a"), lateWrite),
        ]);
        expect(insertError).toBeNull();

        const chunk = await repository.getTraceChunk(
          "taskEventPartitioned",
          ENV_ID,
          TRACE_ID,
          new Date(BASE.getTime() - 60_000),
          undefined,
          undefined,
          { includeDebugLogs: true, limit: 100, tailInsertedAtSinceMs: tailSince.getTime() }
        );

        expect(chunk?.events.map((e) => e.message).sort()).toEqual(["b-complete", "c"]);
        expect(chunk?.events.every((e) => Number(e.insertedAt) >= tailSince.getTime())).toBe(true);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

function statusEvent(
  spanId: string,
  offsetMs: number,
  parentSpanId: string,
  kind: string,
  status: string
): TaskEventV2Input {
  return { ...event(spanId, offsetMs, spanId, parentSpanId), kind, status };
}

describe("ClickhouseEventRepository getTraceErrorEvents", () => {
  clickhouseTest(
    "returns every error span plus its ancestor chain",
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

      const events: TaskEventV2Input[] = [
        statusEvent("r", 0, "", "SPAN", "OK"),
        statusEvent("a", 10, "r", "SPAN", "OK"),
        statusEvent("b", 20, "a", "SPAN", "OK"),
        statusEvent("err1", 30, "b", "SPAN", "ERROR"),
        statusEvent("g1", 35, "err1", "SPAN", "OK"),
        statusEvent("g2", 36, "err1", "SPAN", "OK"),
        statusEvent("gg1", 37, "g1", "SPAN", "OK"),
        statusEvent("c", 40, "r", "SPAN", "OK"),
        statusEvent("d", 50, "c", "LOG_INFO", "OK"),
        statusEvent("err2", 60, "r", "SPAN", "ERROR"),
      ];

      try {
        const [insertError] = await clickhouse.taskEventsV2.insert(events);
        expect(insertError).toBeNull();

        const errorEvents = await repository.getTraceErrorEvents(
          "taskEventPartitioned",
          ENV_ID,
          TRACE_ID,
          new Date(BASE.getTime() - 60_000),
          new Date(BASE.getTime() + 60_000),
          { includeDebugLogs: true }
        );

        expect(errorEvents?.isTruncated).toBe(false);
        const spanIds = new Set(errorEvents!.events.map((e) => e.spanId));
        expect(spanIds).toEqual(new Set(["r", "a", "b", "err1", "g1", "g2", "err2"]));
        expect(spanIds.has("c")).toBe(false);
        expect(spanIds.has("d")).toBe(false);
        expect(spanIds.has("gg1")).toBe(false);
        expect(
          errorEvents!.events
            .filter((e) => e.status === "ERROR")
            .map((e) => e.spanId)
            .sort()
        ).toEqual(["err1", "err2"]);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );

  clickhouseTest(
    "returns an empty array for a trace with no errors",
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
        const [insertError] = await clickhouse.taskEventsV2.insert([
          statusEvent("only", 0, "", "SPAN", "OK"),
        ]);
        expect(insertError).toBeNull();

        const errorEvents = await repository.getTraceErrorEvents(
          "taskEventPartitioned",
          ENV_ID,
          TRACE_ID,
          new Date(BASE.getTime() - 60_000),
          new Date(BASE.getTime() + 60_000),
          { includeDebugLogs: true }
        );
        expect(errorEvents).toEqual({ events: [], isTruncated: false });
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

describe("ClickhouseEventRepository getTraceErrorEvents caps", () => {
  clickhouseTest(
    "flags truncation and returns a stable subset past the match cap",
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
        const [insertError] = await clickhouse.taskEventsV2.insert([
          statusEvent("r", 0, "", "SPAN", "OK"),
          ...Array.from({ length: 5_005 }, (_, i) =>
            statusEvent(`err${i}`, 10 + i, "r", "SPAN", "ERROR")
          ),
        ]);
        expect(insertError).toBeNull();

        const fetchErrors = () =>
          repository.getTraceErrorEvents(
            "taskEventPartitioned",
            ENV_ID,
            TRACE_ID,
            new Date(BASE.getTime() - 60_000),
            new Date(BASE.getTime() + 60_000),
            { includeDebugLogs: true }
          );

        const first = await fetchErrors();
        const second = await fetchErrors();

        expect(first?.isTruncated).toBe(true);
        const firstErrors = first!.events.filter((e) => e.status === "ERROR").map((e) => e.spanId);
        expect(firstErrors).toHaveLength(5_000);
        expect(first!.events.some((e) => e.spanId === "r")).toBe(true);
        expect(new Set(second!.events.map((e) => e.spanId))).toEqual(
          new Set(first!.events.map((e) => e.spanId))
        );
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

describe("ClickhouseEventRepository getTraceErrorEvents at the cap", () => {
  clickhouseTest(
    "does not flag exactly the match cap as truncated",
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
        const [insertError] = await clickhouse.taskEventsV2.insert([
          statusEvent("r", 0, "", "SPAN", "OK"),
          ...Array.from({ length: 5_000 }, (_, i) =>
            statusEvent(`err${i}`, 10 + i, "r", "SPAN", "ERROR")
          ),
        ]);
        expect(insertError).toBeNull();

        const result = await repository.getTraceErrorEvents(
          "taskEventPartitioned",
          ENV_ID,
          TRACE_ID,
          new Date(BASE.getTime() - 60_000),
          new Date(BASE.getTime() + 60_000),
          { includeDebugLogs: true }
        );

        expect(result?.isTruncated).toBe(false);
        expect(result?.events.filter((e) => e.status === "ERROR")).toHaveLength(5_000);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});

describe("ClickhouseEventRepository getTraceSpanWithAncestors", () => {
  clickhouseTest(
    "returns a span plus its ancestor chain, not siblings",
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
      const events: TaskEventV2Input[] = [
        statusEvent("r", 0, "", "SPAN", "OK"),
        statusEvent("a", 10, "r", "SPAN", "OK"),
        statusEvent("aSibling", 15, "r", "SPAN", "OK"),
        statusEvent("b", 20, "a", "SPAN", "OK"),
        statusEvent("deep", 30, "b", "SPAN", "OK"),
        statusEvent("bSibling", 35, "b", "SPAN", "OK"),
      ];
      try {
        const [insertError] = await clickhouse.taskEventsV2.insert(events);
        expect(insertError).toBeNull();

        const result = await repository.getTraceSpanWithAncestors(
          "taskEventPartitioned",
          ENV_ID,
          TRACE_ID,
          new Date(BASE.getTime() - 60_000),
          new Date(BASE.getTime() + 60_000),
          "deep",
          { includeDebugLogs: true }
        );
        expect(result).toBeDefined();
        const ids = new Set(result!.map((e) => e.spanId));
        expect(ids).toEqual(new Set(["deep", "b", "a", "r"]));
        expect(ids.has("bSibling")).toBe(false);
        expect(ids.has("aSibling")).toBe(false);
      } finally {
        await shutdownRepository(repository);
      }
    }
  );
});
