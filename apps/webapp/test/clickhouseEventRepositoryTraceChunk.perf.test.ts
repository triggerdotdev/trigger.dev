import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { ClickhouseEventRepository } from "~/v3/eventRepository/clickhouseEventRepository.server";
import type { TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";

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

        expect(errorEvents).toBeDefined();
        const spanIds = new Set(errorEvents!.map((e) => e.spanId));
        expect(spanIds).toEqual(new Set(["r", "a", "b", "err1", "g1", "g2", "err2"]));
        expect(spanIds.has("c")).toBe(false);
        expect(spanIds.has("d")).toBe(false);
        expect(spanIds.has("gg1")).toBe(false);
        expect(
          errorEvents!
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
        expect(errorEvents).toEqual([]);
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

describe("ClickhouseEventRepository getTraceSpanCount", () => {
  clickhouseTest("counts distinct spans, not rows", async ({ clickhouseContainer }) => {
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
      const events: TaskEventV2Input[] = [
        event("a", 0, "a", ""),
        event("b", 10, "b", "a"),
        event("d", 20, "d-partial", "b"),
        event("d", 20, "d-complete", "b"),
      ];
      const [insertError] = await clickhouse.taskEventsV2.insert(events);
      expect(insertError).toBeNull();

      const count = await repository.getTraceSpanCount(
        "taskEventPartitioned",
        ENV_ID,
        TRACE_ID,
        new Date(BASE.getTime() - 60_000),
        new Date(BASE.getTime() + 60_000),
        { includeDebugLogs: true }
      );

      expect(count).toBe(3);
    } finally {
      await shutdownRepository(repository);
    }
  });

  clickhouseTest("returns 0 for a trace with no events", async ({ clickhouseContainer }) => {
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
      const count = await repository.getTraceSpanCount(
        "taskEventPartitioned",
        ENV_ID,
        "trace_does_not_exist",
        new Date(BASE.getTime() - 60_000),
        new Date(BASE.getTime() + 60_000),
        { includeDebugLogs: true }
      );

      expect(count).toBe(0);
    } finally {
      await shutdownRepository(repository);
    }
  });
});
