import { ClickHouse, type TaskEventV2Input } from "@internal/clickhouse";
import { PostgresRunStore } from "@internal/run-store";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  TraceChunkPresenter,
  type TraceReadContext,
} from "~/presenters/v3/TraceChunkPresenter.server";
import {
  ClickhouseEventRepository,
  convertDateToClickhouseDateTime,
} from "~/v3/eventRepository/clickhouseEventRepository.server";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000 });

const BASE = new Date("2026-09-01T10:00:00.000Z");
const COMPLETED_AT = new Date(BASE.getTime() + 60 * 60_000);
const DAY_MS = 86_400_000;

function clickhouseDate(value: Date) {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function seed(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { title: "trace-chunk", slug: "trace-chunk" },
  });
  const member = await prisma.user.create({
    data: { email: "member@example.com", authenticationMethod: "MAGIC_LINK" },
  });
  const outsider = await prisma.user.create({
    data: { email: "outsider@example.com", authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: {
      name: "trace-chunk",
      slug: "trace-chunk",
      organizationId: organization.id,
      externalRef: "proj_trace_chunk",
    },
  });
  const environment = (slug: string) =>
    prisma.runtimeEnvironment.create({
      data: {
        slug,
        type: "PRODUCTION",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${slug}`,
        pkApiKey: `pk_${slug}`,
        shortcode: `short-${slug}`,
      },
    });
  const prod = await environment("prod");
  const staging = await environment("staging");

  return { organization, project, prod, staging, member, outsider };
}

async function createRun(
  prisma: PrismaClient,
  seeded: Seeded,
  name: string,
  options: {
    status?: TaskRunStatus;
    completedAt?: Date | null;
    taskEventStore?: string;
    logsDeletedAt?: Date;
    environmentId?: string;
  } = {}
) {
  return prisma.taskRun.create({
    data: {
      id: `run_id_${name}`,
      friendlyId: `run_${name}`,
      taskIdentifier: "chat-agent",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${name}`,
      spanId: `root_${name}`,
      queue: "task/chat-agent",
      runtimeEnvironmentId: options.environmentId ?? seeded.prod.id,
      projectId: seeded.project.id,
      organizationId: seeded.organization.id,
      environmentType: "PRODUCTION",
      engine: "V2",
      createdAt: BASE,
      status: options.status ?? "COMPLETED_SUCCESSFULLY",
      completedAt: options.completedAt === undefined ? COMPLETED_AT : options.completedAt,
      taskEventStore: options.taskEventStore ?? "clickhouse_v2",
      logsDeletedAt: options.logsDeletedAt,
    },
  });
}

function row(
  run: { traceId: string; runtimeEnvironmentId: string; friendlyId: string },
  spanId: string,
  options: {
    parentSpanId?: string;
    startOffsetMs: number;
    insertedAt: Date;
    status?: "OK" | "ERROR";
  }
): TaskEventV2Input {
  return {
    environment_id: run.runtimeEnvironmentId,
    organization_id: "org_trace_chunk",
    project_id: "project_trace_chunk",
    task_identifier: "chat-agent",
    run_id: run.friendlyId,
    start_time: clickhouseDate(new Date(BASE.getTime() + options.startOffsetMs)),
    inserted_at: convertDateToClickhouseDateTime(options.insertedAt),
    duration: "1000000",
    trace_id: run.traceId,
    span_id: spanId,
    parent_span_id: options.parentSpanId ?? "",
    message: spanId,
    kind: "SPAN",
    status: options.status ?? "OK",
    attributes: {},
    metadata: "{}",
    expires_at: clickhouseDate(new Date(Date.now() + DAY_MS)),
  };
}

// Root, a child written within the 7d window, and a child written after it.
function boundRows(run: {
  traceId: string;
  runtimeEnvironmentId: string;
  friendlyId: string;
  spanId: string;
}) {
  return [
    row(run, run.spanId, { startOffsetMs: 0, insertedAt: BASE }),
    row(run, "within_window", {
      parentSpanId: run.spanId,
      startOffsetMs: 1_000,
      insertedAt: new Date(COMPLETED_AT.getTime() + 6 * DAY_MS),
      status: "ERROR",
    }),
    row(run, "after_window", {
      parentSpanId: run.spanId,
      startOffsetMs: 2_000,
      insertedAt: new Date(COMPLETED_AT.getTime() + 8 * DAY_MS),
      status: "ERROR",
    }),
  ];
}

async function withPresenter(
  prisma: PrismaClient,
  clickhouseUrl: string,
  rows: TaskEventV2Input[],
  fn: (presenter: TraceChunkPresenter) => Promise<void>
) {
  const clickhouse = new ClickHouse({ url: clickhouseUrl, name: "test" });
  const repository = new ClickhouseEventRepository({
    clickhouse,
    version: "v2",
    insertStrategy: "insert",
  });
  const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const resolver = new ControlPlaneResolver({
    controlPlanePrimary: prisma,
    controlPlaneReplica: prisma,
    cache: new ControlPlaneCache(),
    splitEnabled: () => false,
  });
  const presenter = new TraceChunkPresenter({
    prismaClient: prisma,
    runStore: store,
    resolveEnvironment: (environmentId) => resolver.resolveAuthenticatedEnv(environmentId),
    getRepository: async () => repository,
  });

  try {
    if (rows.length > 0) {
      const [insertError] = await clickhouse.taskEventsV2.insert(rows);
      expect(insertError).toBeNull();
    }
    await fn(presenter);
  } finally {
    await Promise.all([
      (repository as any)._flushScheduler.shutdown(),
      (repository as any)._llmMetricsFlushScheduler.shutdown(),
      (repository as any)._otlpMetricsFlushScheduler.shutdown(),
    ]);
    await clickhouse.close();
  }
}

function access(seeded: Seeded, runFriendlyId: string, environmentSlug = "prod") {
  return {
    userId: seeded.member.id,
    projectSlug: seeded.project.slug,
    environmentSlug,
    runFriendlyId,
    showDebug: false,
    isAdmin: false,
    showDeletedLogs: false,
  };
}

function startArgs(seeded: Seeded, runFriendlyId: string, environmentSlug = "prod") {
  return {
    ...access(seeded, runFriendlyId, environmentSlug),
    selectedSpanId: undefined,
    emergencySpanCap: undefined,
    v1RerouteEnabled: true,
    context: "session" as const,
  };
}

// Pages through the whole trace one row at a time, so every read after the first uses a cursor.
async function readAllPages(
  presenter: TraceChunkPresenter,
  seeded: Seeded,
  runFriendlyId: string,
  context: TraceReadContext | undefined
) {
  const spanIds: string[] = [];
  let cursor = undefined;
  for (let page = 0; page < 10; page++) {
    const chunk = await presenter.call({
      ...access(seeded, runFriendlyId),
      cursor,
      limit: 1,
      context,
    });
    expect(chunk, "chunk not found").toBeDefined();
    spanIds.push(...chunk!.events.map((event) => event.spanId));
    if (!chunk!.hasMore || !chunk!.nextCursor) {
      return Array.from(new Set(spanIds)).sort();
    }
    cursor = chunk!.nextCursor;
  }
  throw new Error("trace never finished paging");
}

describe("TraceChunkPresenter session context", () => {
  containerTestWithClickhouse(
    "start returns the first chunk of a session run as a progressive trace",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const run = await createRun(prisma, seeded, "progressive");

      await withPresenter(
        prisma,
        clickhouseContainer.getConnectionUrl(),
        [
          row(run, run.spanId, { startOffsetMs: 0, insertedAt: BASE }),
          row(run, "child", { parentSpanId: run.spanId, startOffsetMs: 1_000, insertedAt: BASE }),
        ],
        async (presenter) => {
          const start = await presenter.start(startArgs(seeded, run.friendlyId));

          expect(start?.kind).toBe("progressive");
          if (start?.kind !== "progressive") return;
          expect(start.trace.events.map((event) => event.id).sort()).toEqual(
            ["child", run.spanId].sort()
          );
          expect(start.trace.progressive.firstEvents).toHaveLength(2);
          expect(start.trace.progressive.buildOptions.rootSpanId).toBe(run.spanId);
          expect(start.trace.progressive.liveTailEnabled).toBe(true);
        }
      );
    }
  );

  containerTestWithClickhouse(
    "start returns empty with a tail-ready trace for a live run with no spans yet",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const run = await createRun(prisma, seeded, "empty", {
        status: "EXECUTING",
        completedAt: null,
      });

      await withPresenter(prisma, clickhouseContainer.getConnectionUrl(), [], async (presenter) => {
        const start = await presenter.start(startArgs(seeded, run.friendlyId));

        expect(start?.kind).toBe("empty");
        if (start?.kind !== "empty") return;
        expect(start.trace.events).toEqual([]);
        expect(start.trace.progressive.firstEvents).toEqual([]);
        expect(start.trace.progressive.hasMore).toBe(false);
        expect(start.trace.progressive.firstChunkReadAt).toBeTypeOf("number");
      });
    }
  );

  containerTestWithClickhouse(
    "start reports a finished run with no spans as unavailable instead of empty",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const run = await createRun(prisma, seeded, "finished_empty");

      await withPresenter(prisma, clickhouseContainer.getConnectionUrl(), [], async (presenter) => {
        expect(await presenter.start(startArgs(seeded, run.friendlyId))).toEqual({
          kind: "unavailable",
          reason: "noSpans",
        });
      });
    }
  );

  containerTestWithClickhouse(
    "bounds the deep-link walk for a selected span the same way as the first chunk",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const run = await createRun(prisma, seeded, "deeplink");

      await withPresenter(
        prisma,
        clickhouseContainer.getConnectionUrl(),
        boundRows(run),
        async (presenter) => {
          const start = await presenter.start({
            ...startArgs(seeded, run.friendlyId),
            selectedSpanId: "after_window",
          });

          expect(start?.kind).toBe("progressive");
          if (start?.kind !== "progressive") return;
          expect(start.trace.progressive.supplementaryFirstEvents).toBeUndefined();
          expect(start.trace.events.map((event) => event.id)).not.toContain("after_window");

          const unbounded = await presenter.start({
            ...startArgs(seeded, run.friendlyId),
            selectedSpanId: "after_window",
            context: undefined,
          });
          expect(unbounded?.kind).toBe("progressive");
          if (unbounded?.kind !== "progressive") return;
          expect(unbounded.trace.events.map((event) => event.id)).toContain("after_window");
        }
      );
    }
  );

  containerTestWithClickhouse(
    "start reports deleted logs, a missing anchor and runs that can't load progressively",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const deleted = await createRun(prisma, seeded, "deleted", { logsDeletedAt: COMPLETED_AT });
      const noAnchor = await createRun(prisma, seeded, "no_anchor");
      const legacy = await createRun(prisma, seeded, "legacy", { taskEventStore: "taskEvent" });
      const rerouted = await createRun(prisma, seeded, "rerouted", {
        taskEventStore: "clickhouse",
      });

      await withPresenter(
        prisma,
        clickhouseContainer.getConnectionUrl(),
        [
          row(deleted, deleted.spanId, { startOffsetMs: 0, insertedAt: BASE }),
          row(rerouted, rerouted.spanId, { startOffsetMs: 0, insertedAt: BASE }),
          // The anchor (the run's own span) was never written.
          row(noAnchor, "orphan", {
            parentSpanId: "missing",
            startOffsetMs: 0,
            insertedAt: BASE,
          }),
        ],
        async (presenter) => {
          expect(await presenter.start(startArgs(seeded, deleted.friendlyId))).toEqual({
            kind: "logsDeleted",
          });
          expect(await presenter.start(startArgs(seeded, noAnchor.friendlyId))).toEqual({
            kind: "unavailable",
            reason: "anchorMissing",
          });
          expect(await presenter.start(startArgs(seeded, legacy.friendlyId))).toEqual({
            kind: "unavailable",
            reason: "legacyStore",
          });
          expect(
            await presenter.start({
              ...startArgs(seeded, deleted.friendlyId),
              showDeletedLogs: true,
              emergencySpanCap: 1_000,
            })
          ).toEqual({ kind: "unavailable", reason: "emergencyCap" });
          // The legacy v1 store loads progressively while it's rerouted to v2.
          const reroutedStart = await presenter.start(startArgs(seeded, rerouted.friendlyId));
          expect(reroutedStart?.kind).toBe("progressive");
          expect(
            await presenter.start({
              ...startArgs(seeded, rerouted.friendlyId),
              v1RerouteEnabled: false,
            })
          ).toEqual({ kind: "unavailable", reason: "legacyStore" });
          // The cap wins over the store, as in the session runs list.
          expect(
            await presenter.start({
              ...startArgs(seeded, legacy.friendlyId),
              emergencySpanCap: 1_000,
            })
          ).toEqual({ kind: "unavailable", reason: "emergencyCap" });
        }
      );
    }
  );

  containerTestWithClickhouse(
    "rejects a run from another environment and a user outside the org",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const stagingRun = await createRun(prisma, seeded, "staging", {
        environmentId: seeded.staging.id,
      });

      await withPresenter(
        prisma,
        clickhouseContainer.getConnectionUrl(),
        [row(stagingRun, stagingRun.spanId, { startOffsetMs: 0, insertedAt: BASE })],
        async (presenter) => {
          expect(await presenter.start(startArgs(seeded, stagingRun.friendlyId, "prod"))).toBe(
            undefined
          );
          expect(
            await presenter.call({
              ...access(seeded, stagingRun.friendlyId, "prod"),
              cursor: undefined,
              context: "session",
            })
          ).toBe(undefined);
          expect(
            await presenter.start({
              ...startArgs(seeded, stagingRun.friendlyId, "staging"),
              userId: seeded.outsider.id,
            })
          ).toBe(undefined);

          const own = await presenter.start(startArgs(seeded, stagingRun.friendlyId, "staging"));
          expect(own?.kind).toBe("progressive");
        }
      );
    }
  );

  containerTestWithClickhouse(
    "bounds every session read of a completed run by completedAt + 7d",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const run = await createRun(prisma, seeded, "completed");

      await withPresenter(
        prisma,
        clickhouseContainer.getConnectionUrl(),
        boundRows(run),
        async (presenter) => {
          const start = await presenter.start(startArgs(seeded, run.friendlyId));
          expect(start?.kind).toBe("progressive");
          if (start?.kind !== "progressive") return;
          expect(start.trace.progressive.firstEvents.map((event) => event.spanId).sort()).toEqual(
            [run.spanId, "within_window"].sort()
          );

          expect(await readAllPages(presenter, seeded, run.friendlyId, "session")).toEqual(
            [run.spanId, "within_window"].sort()
          );

          const errors = await presenter.call({
            ...access(seeded, run.friendlyId),
            cursor: undefined,
            filter: "errors",
            context: "session",
          });
          const errorSpanIds = errors!.events.map((event) => event.spanId);
          expect(errorSpanIds).toContain("within_window");
          expect(errorSpanIds).not.toContain("after_window");

          const tail = await presenter.call({
            ...access(seeded, run.friendlyId),
            cursor: undefined,
            tailInsertedAtSinceMs: BASE.getTime(),
            context: "session",
          });
          expect(tail!.events.map((event) => event.spanId)).not.toContain("after_window");
        }
      );
    }
  );

  containerTestWithClickhouse(
    "leaves live runs and reads without the session context unbounded",
    async ({ prisma, clickhouseContainer }) => {
      const seeded = await seed(prisma);
      const completed = await createRun(prisma, seeded, "completed_unbounded");
      const live = await createRun(prisma, seeded, "live", {
        status: "EXECUTING",
        completedAt: null,
      });

      await withPresenter(
        prisma,
        clickhouseContainer.getConnectionUrl(),
        [...boundRows(completed), ...boundRows(live)],
        async (presenter) => {
          const all = (spanId: string) => [spanId, "after_window", "within_window"].sort();

          expect(await readAllPages(presenter, seeded, completed.friendlyId, undefined)).toEqual(
            all(completed.spanId)
          );
          expect(await readAllPages(presenter, seeded, live.friendlyId, "session")).toEqual(
            all(live.spanId)
          );

          const errors = await presenter.call({
            ...access(seeded, completed.friendlyId),
            cursor: undefined,
            filter: "errors",
          });
          expect(errors!.events.map((event) => event.spanId)).toContain("after_window");
        }
      );
    }
  );
});
