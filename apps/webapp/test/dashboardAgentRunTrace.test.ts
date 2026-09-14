// The agent trace has to read the same on both event stores: durations in
// milliseconds and only the customer-visible span events kept: internal
// "trigger.dev/" events are admin-gated, error events reach everyone. Real repositories,
// real Postgres and ClickHouse behind them.
import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { EventRepository } from "~/v3/eventRepository/eventRepository.server";
import type { IEventRepository } from "~/v3/eventRepository/eventRepository.types";

const ctx = vi.hoisted(() => ({
  repository: undefined as unknown as IEventRepository,
}));

vi.mock("~/v3/eventRepository/index.server", () => ({
  getEventRepositoryForStore: async () => ctx.repository,
}));

const { getDashboardAgentRunTrace } = await import("~/services/dashboardAgentRunTrace.server");
type DashboardAgentTraceSpan = NonNullable<
  Awaited<ReturnType<typeof getDashboardAgentRunTrace>>
>["trace"]["rootSpan"];

const TIMEOUT_MS = 60_000;
const ROOT_DURATION_NS = 1_500_000_000;
const CHILD_DURATION_NS = 250_000_000;
const TASK_IDENTIFIER = "send-receipt";

const traceId = "a".repeat(32);
const rootSpanId = "rootspan00000001";
const childSpanId = "childspan0000001";
const foreignSpanId = "foreignspan00001";
const runId = "run_agent_trace";
const foreignRunId = "run_other_environment";

function clickhouseStartTime(ms: number): string {
  const nanoseconds = (BigInt(ms) * 1_000_000n).toString();
  return `${nanoseconds.substring(0, 10)}.${nanoseconds.substring(10)}`;
}

async function readTrace({
  repository,
  prisma,
  environmentId,
  organizationId,
  createdAt,
  anchorTraceId = traceId,
  anchorSpanId = rootSpanId,
}: {
  repository: IEventRepository;
  prisma: PrismaClient;
  environmentId: string;
  organizationId: string;
  createdAt: Date;
  anchorTraceId?: string;
  anchorSpanId?: string;
}) {
  ctx.repository = repository;

  return await getDashboardAgentRunTrace({
    run: {
      friendlyId: runId,
      traceId: anchorTraceId,
      spanId: anchorSpanId,
      createdAt,
      completedAt: null,
      taskEventStore: "taskEvent",
    },
    environmentId,
    organizationId,
    prisma,
  });
}

async function postgresTrace(
  prisma: PrismaClient,
  {
    environmentId,
    organizationId,
  }: {
    environmentId: string;
    organizationId: string;
  }
) {
  const repository = new EventRepository(prisma, prisma, {
    batchSize: 1,
    batchInterval: 10,
    retentionInDays: 1,
    partitioningEnabled: false,
  });

  const startedAt = new Date();

  function makeEvent({
    spanId,
    parentId,
    duration,
    startOffsetMs = 0,
    spanRunId = runId,
  }: {
    spanId: string;
    parentId?: string;
    duration: number;
    startOffsetMs?: number;
    spanRunId?: string;
  }) {
    return {
      traceId,
      spanId,
      parentId,
      message: spanId === rootSpanId ? TASK_IDENTIFIER : "fetch-invoices",
      isError: false,
      isPartial: false,
      isCancelled: false,
      level: "TRACE" as const,
      kind: "INTERNAL" as const,
      status: "OK" as const,
      startTime: BigInt(startedAt.getTime() + startOffsetMs) * 1_000_000n,
      duration,
      environmentId,
      environmentType: "DEVELOPMENT" as const,
      organizationId,
      projectId: "proj_agent_trace",
      runId: spanRunId,
      taskSlug: TASK_IDENTIFIER,
      properties: {},
      metadata: {},
      style: {},
    };
  }

  const events = [
    {
      ...makeEvent({ spanId: rootSpanId, duration: ROOT_DURATION_NS }),
      events: [
        {
          name: "trigger.dev/dequeue",
          time: new Date(startedAt.getTime() + 1).toISOString(),
          properties: { event: "dequeue" },
        },
        {
          name: "trigger.dev/create_attempt",
          time: new Date(startedAt.getTime() + 2).toISOString(),
          properties: { event: "create_attempt" },
        },
        {
          name: "trigger.dev/pod_scheduled",
          time: new Date(startedAt.getTime() + 3).toISOString(),
          properties: { event: "pod_scheduled" },
        },
        {
          name: "trigger.dev/whatever",
          time: new Date(startedAt.getTime() + 4).toISOString(),
          properties: {},
        },
        {
          name: "exception",
          time: new Date(startedAt.getTime() + 5).toISOString(),
          properties: { exception: { message: "boom" } },
        },
      ] as any,
    },
    makeEvent({
      spanId: childSpanId,
      parentId: rootSpanId,
      duration: CHILD_DURATION_NS,
      startOffsetMs: 10,
    }),
    makeEvent({
      spanId: foreignSpanId,
      parentId: rootSpanId,
      duration: CHILD_DURATION_NS,
      startOffsetMs: 20,
      spanRunId: foreignRunId,
    }),
  ];

  await repository.insertManyImmediate(events);

  return await readTrace({
    repository,
    prisma,
    environmentId,
    organizationId,
    createdAt: new Date(startedAt.getTime() - 60_000),
  });
}

async function clickhouseTrace(
  prisma: PrismaClient,
  {
    connectionUrl,
    environmentId,
    organizationId,
    insert = true,
    maximumTraceSummaryViewCount,
  }: {
    connectionUrl: string;
    environmentId: string;
    organizationId: string;
    insert?: boolean;
    maximumTraceSummaryViewCount?: number;
  }
) {
  const clickhouse = new ClickHouse({ url: connectionUrl, logLevel: "error" });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    maximumTraceSummaryViewCount,
  });

  const baseMs = Date.now();
  const expiresAt = convertDateToClickhouseDateTime(new Date(baseMs + 24 * 60 * 60 * 1000));

  function makeRow(row: Partial<TaskEventV2Input>): TaskEventV2Input {
    return {
      environment_id: environmentId,
      organization_id: organizationId,
      project_id: "proj_agent_trace",
      task_identifier: TASK_IDENTIFIER,
      run_id: runId,
      trace_id: traceId,
      start_time: clickhouseStartTime(baseMs),
      duration: "0",
      span_id: rootSpanId,
      parent_span_id: "",
      message: TASK_IDENTIFIER,
      kind: "SPAN",
      status: "OK",
      attributes: {},
      metadata: "{}",
      expires_at: expiresAt,
      ...row,
    } as TaskEventV2Input;
  }

  const rows: TaskEventV2Input[] = [
    makeRow({ duration: String(ROOT_DURATION_NS) }),
    makeRow({
      span_id: childSpanId,
      parent_span_id: rootSpanId,
      message: "fetch-invoices",
      start_time: clickhouseStartTime(baseMs + 10),
      duration: String(CHILD_DURATION_NS),
    }),
    makeRow({
      span_id: foreignSpanId,
      parent_span_id: rootSpanId,
      run_id: foreignRunId,
      message: "fetch-invoices",
      start_time: clickhouseStartTime(baseMs + 20),
      duration: String(CHILD_DURATION_NS),
    }),
    makeRow({
      kind: "SPAN_EVENT",
      message: "trigger.dev/dequeue",
      start_time: clickhouseStartTime(baseMs + 1),
      metadata: JSON.stringify({ event: "dequeue" }),
    }),
    makeRow({
      kind: "SPAN_EVENT",
      message: "trigger.dev/create_attempt",
      start_time: clickhouseStartTime(baseMs + 2),
      metadata: JSON.stringify({ event: "create_attempt" }),
    }),
    makeRow({
      kind: "SPAN_EVENT",
      message: "trigger.dev/pod_scheduled",
      start_time: clickhouseStartTime(baseMs + 3),
      metadata: JSON.stringify({ event: "pod_scheduled" }),
    }),
    makeRow({
      kind: "SPAN_EVENT",
      message: "trigger.dev/whatever",
      start_time: clickhouseStartTime(baseMs + 4),
      metadata: "{}",
    }),
    makeRow({
      kind: "SPAN_EVENT",
      message: "exception",
      start_time: clickhouseStartTime(baseMs + 5),
      metadata: JSON.stringify({ "exception.message": "boom" }),
    }),
  ];

  if (insert) {
    const [insertError] = await clickhouse.taskEventsV2.insert(rows, {
      clickhouse_settings: { async_insert: 0 },
    });
    expect(insertError).toBeNull();
  }

  return await readTrace({
    repository,
    prisma,
    environmentId,
    organizationId,
    createdAt: new Date(baseMs - 60_000),
  });
}

function chainSpanIdAt(index: number): string {
  return index === 0 ? rootSpanId : `chainspan${String(index).padStart(8, "0")}`;
}

// `depth` is the descendant count: the chain has `depth + 1` spans total (root plus `depth`
// descendants), so the deepest span is chainSpanIdAt(depth).
async function insertSpanChain({
  repository,
  environmentId,
  organizationId,
  startedAt,
  depth,
}: {
  repository: IEventRepository;
  environmentId: string;
  organizationId: string;
  startedAt: Date;
  depth: number;
}) {
  const events = [];

  for (let index = 0; index <= depth; index++) {
    events.push({
      traceId,
      spanId: chainSpanIdAt(index),
      parentId: index === 0 ? undefined : chainSpanIdAt(index - 1),
      message: index === 0 ? TASK_IDENTIFIER : "fetch-invoices",
      isError: false,
      isPartial: false,
      isCancelled: false,
      level: "TRACE" as const,
      kind: "INTERNAL" as const,
      status: "OK" as const,
      startTime: BigInt(startedAt.getTime() + index) * 1_000_000n,
      duration: CHILD_DURATION_NS,
      environmentId,
      environmentType: "DEVELOPMENT" as const,
      organizationId,
      projectId: "proj_agent_trace",
      runId,
      taskSlug: TASK_IDENTIFIER,
      properties: {},
      metadata: {},
      style: {},
    });
  }

  const BATCH_SIZE = 500;
  for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
    await repository.insertManyImmediate(events.slice(offset, offset + BATCH_SIZE));
  }
}

async function setupChainFixture(prisma: PrismaClient) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const environmentId = environment.id;
  const organizationId = environment.organizationId;

  await prisma.taskRun.create({
    data: {
      friendlyId: runId,
      taskIdentifier: TASK_IDENTIFIER,
      payload: "{}",
      payloadType: "application/json",
      traceId,
      spanId: rootSpanId,
      queue: `task/${TASK_IDENTIFIER}`,
      runtimeEnvironmentId: environmentId,
      projectId: environment.projectId,
      organizationId,
    },
  });

  const repository = new EventRepository(prisma, prisma, {
    batchSize: 1,
    batchInterval: 10,
    retentionInDays: 1,
    partitioningEnabled: false,
  });

  return { repository, environmentId, organizationId, startedAt: new Date() };
}

function deepestSpanId(rootSpan: DashboardAgentTraceSpan | undefined): string | undefined {
  let node = rootSpan;
  let deepest: string | undefined;

  while (node) {
    deepest = node.id;
    node = node.children[0];
  }

  return deepest;
}

function depthOf(rootSpan: DashboardAgentTraceSpan | undefined): number {
  let node = rootSpan;
  let depth = -1;

  while (node) {
    depth++;
    node = node.children[0];
  }

  return depth;
}

describe("the dashboard agent run trace", () => {
  containerTest(
    "reports the same millisecond durations, task slugs and customer-visible events on both event stores",
    async ({ prisma, clickhouseContainer }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const environmentId = environment.id;
      const organizationId = environment.organizationId;
      const otherEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          type: "STAGING",
          slug: "other",
          projectId: environment.projectId,
          organizationId,
          apiKey: "api_key_other",
          pkApiKey: "pk_api_key_other",
          shortcode: "short_code_other",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: runId,
          taskIdentifier: TASK_IDENTIFIER,
          payload: "{}",
          payloadType: "application/json",
          traceId,
          spanId: rootSpanId,
          queue: `task/${TASK_IDENTIFIER}`,
          runtimeEnvironmentId: environmentId,
          projectId: environment.projectId,
          organizationId,
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: foreignRunId,
          taskIdentifier: "other-task",
          payload: "{}",
          payloadType: "application/json",
          traceId,
          spanId: foreignSpanId,
          queue: "task/other-task",
          runtimeEnvironmentId: otherEnvironment.id,
          projectId: otherEnvironment.projectId,
          organizationId,
        },
      });

      const fromPostgres = await postgresTrace(prisma, { environmentId, organizationId });
      const fromClickhouse = await clickhouseTrace(prisma, {
        connectionUrl: clickhouseContainer.getConnectionUrl(),
        environmentId,
        organizationId,
      });

      for (const result of [fromPostgres, fromClickhouse]) {
        expect(result?.trace.rootSpan.id).toBe(rootSpanId);
        expect(result?.trace.rootSpan.data.durationMs).toBe(1_500);
        expect(result?.trace.rootSpan.data.taskSlug).toBe(TASK_IDENTIFIER);
        // Admin-only and unknown internal events must never reach the agent, but the
        // error event the run page shows everyone must survive.
        expect(result?.trace.rootSpan.data.events.map((event) => event.name).sort()).toEqual([
          "exception",
          "trigger.dev/dequeue",
        ]);
        expect(result?.trace.rootSpan.children).toHaveLength(2);
        expect(result?.trace.rootSpan.children[0]?.data.durationMs).toBe(250);
        expect(result?.trace.rootSpan.children[0]?.data.taskSlug).toBe(TASK_IDENTIFIER);
        // The run behind this span lives in another environment, so it must not be named.
        expect(result?.trace.rootSpan.children[1]?.id).toBe(foreignSpanId);
        expect(result?.trace.rootSpan.children[1]?.data.taskSlug).toBeUndefined();
        expect(result?.trace.isTruncated).toBeUndefined();
      }

      expect(fromPostgres?.trace.rootSpan.data.durationMs).toBe(
        fromClickhouse?.trace.rootSpan.data.durationMs
      );

      // Only the ClickHouse repository caps a trace summary, so truncation is read there.
      const truncated = await clickhouseTrace(prisma, {
        connectionUrl: clickhouseContainer.getConnectionUrl(),
        environmentId,
        organizationId,
        insert: false,
        maximumTraceSummaryViewCount: 2,
      });

      expect(truncated?.trace.isTruncated).toBe(true);
      expect(truncated && "isTruncated" in truncated).toBe(false);
    },
    TIMEOUT_MS
  );

  containerTest(
    "keeps a chain well under the depth guard fully intact and JSON-serializable",
    async ({ prisma }) => {
      const { repository, environmentId, organizationId, startedAt } =
        await setupChainFixture(prisma);

      await insertSpanChain({ repository, environmentId, organizationId, startedAt, depth: 1_000 });

      const result = await readTrace({
        repository,
        prisma,
        environmentId,
        organizationId,
        createdAt: new Date(startedAt.getTime() - 60_000),
      });

      expect(result?.trace.isTruncated).toBeUndefined();
      expect(deepestSpanId(result?.trace.rootSpan)).toBe(chainSpanIdAt(1_000));
      expect(() => JSON.stringify(result)).not.toThrow();
    },
    TIMEOUT_MS
  );

  containerTest(
    "does not truncate a chain of exactly the depth guard",
    async ({ prisma }) => {
      const { repository, environmentId, organizationId, startedAt } =
        await setupChainFixture(prisma);

      await insertSpanChain({
        repository,
        environmentId,
        organizationId,
        startedAt,
        depth: 1_500,
      });

      const result = await readTrace({
        repository,
        prisma,
        environmentId,
        organizationId,
        createdAt: new Date(startedAt.getTime() - 60_000),
      });

      expect(result?.trace.isTruncated).toBeUndefined();
      expect(deepestSpanId(result?.trace.rootSpan)).toBe(chainSpanIdAt(1_500));
    },
    TIMEOUT_MS
  );

  containerTest(
    "truncates a chain deeper than the depth guard instead of throwing",
    async ({ prisma }) => {
      const { repository, environmentId, organizationId, startedAt } =
        await setupChainFixture(prisma);

      await insertSpanChain({
        repository,
        environmentId,
        organizationId,
        startedAt,
        depth: 2_000,
      });

      const result = await readTrace({
        repository,
        prisma,
        environmentId,
        organizationId,
        createdAt: new Date(startedAt.getTime() - 60_000),
      });

      expect(result?.trace.isTruncated).toBe(true);
      // The root itself isn't a descendant, so a depth of 1,500 means 1,501 nodes total.
      expect(depthOf(result?.trace.rootSpan)).toBe(1_500);
      expect(() => JSON.stringify(result)).not.toThrow();
    },
    TIMEOUT_MS
  );
});
