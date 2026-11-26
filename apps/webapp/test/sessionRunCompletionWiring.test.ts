// Which run-engine events queue the "did this session's run leave a message unread" check, and for
// which runs. Drives the real registered event handlers on a real event bus against a real
// Postgres; the job queue is the suite-wide stub, so what is asserted is what gets enqueued.

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));
const busHolder = vi.hoisted(() => ({ bus: undefined as any }));

vi.mock("~/v3/runEngine.server", async () => {
  const { EventEmitter } = await import("node:events");
  busHolder.bus = new EventEmitter();
  return { engine: { eventBus: busHolder.bus } };
});

vi.mock("~/db.server", () => {
  const lazy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (!primaryHolder.client) throw new Error("primaryHolder.client not set for this test");
        return primaryHolder.client[prop];
      },
    }
  );
  return {
    prisma: lazy,
    $replica: lazy,
    runOpsNewReplica: lazy,
    runOpsLegacyReplica: lazy,
    runOpsNewPrismaClient: lazy,
    runOpsLegacyPrismaClient: lazy,
    runOpsShardHandles: [],
  };
});

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = storeHolder.store as Record<string | symbol, unknown>;
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/v3/eventRepository/index.server", () => {
  const noop: any = new Proxy(() => Promise.resolve(undefined), {
    get: (_t, prop) => (prop === "then" ? undefined : noop),
    apply: () => Promise.resolve(undefined),
  });
  return { getEventRepositoryForStore: async () => noop, recordRunDebugLog: noop };
});

const publishState = vi.hoisted(() => ({ runIds: [] as string[] }));

vi.mock("~/services/realtime/runChangeNotifierInstance.server", () => ({
  publishChangeRecord: (record: { runId: string }) => publishState.runIds.push(record.runId),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import { commonWorker } from "~/v3/commonWorker.server";
import { registerRunEngineEventBusHandlers } from "~/v3/runEngineHandlers.server";

const agentAnnotations = {
  triggerSource: "session",
  triggerAction: "trigger",
  rootTriggerSource: "session",
  taskKind: "AGENT",
};

let counter = 0;
let registered = false;

async function setup(prisma: PrismaClient) {
  const suffix = `wire_${counter++}`;
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  primaryHolder.client = prisma;
  storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  publishState.runIds.length = 0;
  vi.mocked(commonWorker.enqueueOnce).mockClear();
  if (!registered) {
    registerRunEngineEventBusHandlers();
    registered = true;
  }
  return { suffix, organization, project, environment };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function createRun(ctx: Ctx, name: string, annotations: unknown, session = false) {
  const runId = `${name}${ctx.suffix}`.padEnd(24, "x");
  const input: CreateRunInput = {
    data: {
      id: runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: `run_${name}_${ctx.suffix}`,
      runtimeEnvironmentId: ctx.environment.id,
      environmentType: "PRODUCTION",
      organizationId: ctx.organization.id,
      projectId: ctx.project.id,
      taskIdentifier: "my-chat",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-chat",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date(Date.now() - 60_000),
      annotations: annotations as never,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "test",
      runStatus: "COMPLETED_SUCCESSFULLY",
      environmentId: ctx.environment.id,
      environmentType: "PRODUCTION",
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
    },
  };
  await (storeHolder.store as PostgresRunStore).createRun(input);
  if (session) {
    await (primaryHolder.client as PrismaClient).session.create({
      data: {
        friendlyId: `session_${name}_${ctx.suffix}`,
        externalId: `chat-${name}-${ctx.suffix}`,
        type: "chat.agent",
        projectId: ctx.project.id,
        runtimeEnvironmentId: ctx.environment.id,
        environmentType: "PRODUCTION",
        organizationId: ctx.organization.id,
        taskIdentifier: "my-chat",
        triggerConfig: { basePayload: {} } as never,
        currentRunId: runId,
      },
    });
  }
  return runId;
}

function eventFor(ctx: Ctx, runId: string, extra: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    time: now,
    run: {
      id: runId,
      friendlyId: `run_${runId}`,
      status: "COMPLETED_SUCCESSFULLY",
      spanId: "span_1",
      output: undefined,
      outputType: "application/json",
      error: { type: "STRING_ERROR", raw: "boom" },
      ttl: "1m",
      taskEventStore: "taskEvent",
      createdAt: new Date(now.getTime() - 60_000),
      completedAt: now,
      expiredAt: now,
      updatedAt: now,
      usageDurationMs: 1,
      costInCents: 0,
      attemptNumber: 1,
      ...extra,
    },
    organization: { id: ctx.organization.id },
    project: { id: ctx.project.id },
    environment: { id: ctx.environment.id },
  };
}

/** Emit the event, wait for its handler to get past the existing run read, then let it settle. */
async function emitAndSettle(event: string, payload: unknown, runId: string) {
  const reached = publishState.runIds.length;
  busHolder.bus.emit(event, payload);
  if (event !== "runExpired") {
    await vi.waitFor(() => expect(publishState.runIds.length).toBeGreaterThan(reached));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return vi
    .mocked(commonWorker.enqueueOnce)
    .mock.calls.map(([job]) => job as { job: string; payload: { runId: string } })
    .filter((job) => job.payload?.runId === runId);
}

describe("which run endings queue the session continuation check", () => {
  // Catches: the check being queued for the wrong endings: a succeeded or failed agent run that is
  // a session's current run must queue it (that is the gap), once, with what the job needs,
  // including how the run ended (a failed run's turn is not retried, a succeeded run's is).
  postgresTest(
    "queues it for a session's current run that succeeded or failed",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const succeeded = await createRun(ctx, "ok", agentAnnotations, true);
      const failed = await createRun(ctx, "bad", agentAnnotations, true);

      const afterSuccess = await emitAndSettle("runSucceeded", eventFor(ctx, succeeded), succeeded);
      const afterFailure = await emitAndSettle(
        "runFailed",
        eventFor(ctx, failed, { status: "COMPLETED_WITH_ERRORS" }),
        failed
      );

      expect(afterSuccess).toHaveLength(1);
      expect(afterSuccess[0]).toMatchObject({
        job: "sessionRun.continueIfInputUnread",
        payload: { runId: succeeded, environmentId: ctx.environment.id, outcome: "succeeded" },
      });
      expect(afterFailure).toHaveLength(1);
      expect(afterFailure[0]!.job).toBe("sessionRun.continueIfInputUnread");
      expect(afterFailure[0]!.payload).toMatchObject({ runId: failed, outcome: "failed" });
    }
  );

  // Catches: the anchor recorded in the run's annotations not reaching the queued job, which would
  // judge every ended run by timestamp, and an older run without one breaking the enqueue.
  postgresTest(
    "carries the run's recorded .in seq into the queued job, and none when it has none",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const anchored = await createRun(
        ctx,
        "anch",
        { ...agentAnnotations, sessionInSeq: 12, sessionInFirstSeq: 9 },
        true
      );
      const plain = await createRun(ctx, "plain", agentAnnotations, true);

      const afterAnchored = await emitAndSettle("runSucceeded", eventFor(ctx, anchored), anchored);
      const afterPlain = await emitAndSettle("runSucceeded", eventFor(ctx, plain), plain);

      expect(afterAnchored[0]!.payload).toMatchObject({
        runId: anchored,
        sessionInSeq: 12,
        sessionInFirstSeq: 9,
      });
      const plainPayload = afterPlain[0]!.payload as {
        sessionInSeq?: number;
        sessionInFirstSeq?: number;
      };
      expect(plainPayload.sessionInSeq).toBeUndefined();
      expect(plainPayload.sessionInFirstSeq).toBeUndefined();
    }
  );

  // Catches: a cancel restarting a conversation whose run someone stopped on purpose, and an
  // expired run (it never started, so it read nothing) queuing work.
  postgresTest("queues nothing for a cancelled or an expired run", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const cancelled = await createRun(ctx, "cancel", agentAnnotations, true);
    const expired = await createRun(ctx, "expire", agentAnnotations, true);

    const afterCancel = await emitAndSettle(
      "runCancelled",
      eventFor(ctx, cancelled, { status: "CANCELED" }),
      cancelled
    );
    const afterExpiry = await emitAndSettle(
      "runExpired",
      eventFor(ctx, expired, { status: "EXPIRED" }),
      expired
    );

    expect(afterCancel).toHaveLength(0);
    expect(afterExpiry).toHaveLength(0);
  });

  // Catches: every run ending paying for the check: only an agent run that is a session's current
  // run is queued, so other runs cost no queue write and no session read.
  postgresTest(
    "queues nothing for a run that is not an agent run, or not a session's current run",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const standard = await createRun(
        ctx,
        "std",
        { ...agentAnnotations, taskKind: "STANDARD" },
        true
      );
      const detached = await createRun(ctx, "detached", agentAnnotations, false);

      expect(await emitAndSettle("runSucceeded", eventFor(ctx, standard), standard)).toHaveLength(
        0
      );
      expect(await emitAndSettle("runSucceeded", eventFor(ctx, detached), detached)).toHaveLength(
        0
      );
    }
  );
});
