// The session version floor, driven through the real `ensureRunForSession` / `swapSessionRun` against
// a real Postgres: a live run or a pin below the environment's floor is not used for the next run.

import { postgresTest } from "@internal/testcontainers";
import { $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));

const peekState = vi.hoisted(() => ({
  calls: [] as string[],
  result: true,
  backend: "s2" as "s2" | "other",
  onPeek: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("~/services/realtime/s2realtimeStreams.server", () => ({
  S2RealtimeStreams: class {
    async peekSessionOutTail(addressingKey: string) {
      peekState.calls.push(addressingKey);
      await peekState.onPeek?.();
      return peekState.result
        ? { kind: "record", control: "turn-complete", timestamp: 0, inConsumedSeq: 0 }
        : { kind: "record", control: undefined, timestamp: Date.now(), inConsumedSeq: undefined };
    }
    async readSessionInTailSeq() {
      return 1;
    }
  },
}));

vi.mock("~/services/realtime/v1StreamsGlobal.server", async () => {
  const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");
  return {
    determineRealtimeStreamsVersion: () => "v2",
    getRealtimeStreamInstance: () =>
      peekState.backend === "s2"
        ? new (S2RealtimeStreams as unknown as new () => object)()
        : { peekSessionOutTail: async () => ({ kind: "empty" }) },
  };
});

const waitState = vi.hoisted(() => ({
  calls: [] as Array<[string, string]>,
  ids: [] as string[],
}));

vi.mock("~/services/sessionStreamWaitpointCache.server", () => ({
  listSessionStreamWaitpoints: async (
    _environmentId: string,
    addressingKey: string,
    io: string
  ) => {
    waitState.calls.push([addressingKey, io]);
    return waitState.ids;
  },
}));

const triggerState = vi.hoisted(() => ({
  calls: [] as Array<{ taskIdentifier: string; body: any; options: any }>,
  result: { run: { id: "", friendlyId: "", status: "PENDING" } } as {
    run: { id: string; friendlyId: string; status: string };
  },
}));

vi.mock("~/db.server", () => {
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(primaryHolder, "primaryHolder.client"),
    // The real shared transaction helper on the per-test writer; only the webapp wrapper's span
    // and logging are absent.
    $transaction: (_client: unknown, nameOrFn: unknown, fnOrOptions?: unknown, options?: unknown) =>
      realTransaction(
        primaryHolder.client,
        (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as any,
        () => {},
        (typeof nameOrFn === "function" ? fnOrOptions : options) as any
      ),
  };
});

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = storeHolder.store as Record<string | symbol, unknown>;
        if (!store) throw new Error("test bug: storeHolder.store not set before caller ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    async call(taskIdentifier: string, _environment: any, body: any, options: any) {
      triggerState.calls.push({ taskIdentifier, body, options });
      return triggerState.result;
    }
  },
}));

const cancelState = vi.hoisted(() => ({
  calls: [] as Array<{ runId: string; friendlyId: string; reason: string | undefined }>,
  failRunId: undefined as string | undefined,
  onCancel: undefined as undefined | ((runId: string) => Promise<void>),
}));

vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call(run: { id: string; friendlyId: string }, options?: { reason?: string }) {
      if (cancelState.failRunId === run.id) throw new Error("cancel failed");
      await cancelState.onCancel?.(run.id);
      cancelState.calls.push({
        runId: run.id,
        friendlyId: run.friendlyId,
        reason: options?.reason,
      });
    }
  },
}));

const resolveState = vi.hoisted(() => ({
  calls: [] as string[],
  resolutions: {} as Record<string, string | null>,
}));

vi.mock("~/services/externalDeploymentCacheInstance.server", () => ({
  externalDeploymentCacheInstance: {},
}));

vi.mock("~/v3/services/resolveExternalDeployment.server", () => ({
  resolveExternalDeployment: async (options: { externalDeploymentId: string }) => {
    resolveState.calls.push(options.externalDeploymentId);
    const version = resolveState.resolutions[options.externalDeploymentId];
    return version
      ? {
          outcome: "deployed",
          worker: { workerId: "worker_1", version, sdkVersion: "4.0.0", cliVersion: "4.0.0" },
        }
      : { outcome: "park" };
  },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import {
  ensureRunForSession,
  SessionClosedError,
  swapSessionRun,
} from "~/services/realtime/sessionRunManager.server";

const FLOOR_REASON = "Superseded by session version floor";
const V1 = "20261101.1";
const V2 = "20261108.2";

let seq = 0;

const cuidRunId = (suffix: string) => `run_${suffix.padEnd(24, "x").slice(0, 24)}`;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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
  return { organization, project, environment };
}

type Seed = Awaited<ReturnType<typeof seedTenant>>;

function environmentFor(seed: Seed, floor?: Record<string, unknown>) {
  return {
    id: seed.environment.id,
    type: "PRODUCTION",
    organization: {
      streamBasinName: null,
      featureFlags: floor ? { sessionVersionFloor: { [seed.environment.id]: floor } } : {},
    },
  } as unknown as AuthenticatedEnvironment;
}

async function promote(prisma: PrismaClient, seed: Seed, version: string) {
  const deployment = await prisma.workerDeployment.create({
    data: {
      contentHash: `hash_${version}`,
      friendlyId: `deployment_${seed.environment.id}_${version}`,
      shortCode: `dep_${seed.environment.id}_${version}`,
      version,
      projectId: seed.project.id,
      environmentId: seed.environment.id,
    },
  });
  await prisma.workerDeploymentPromotion.upsert({
    where: { environmentId_label: { environmentId: seed.environment.id, label: "current" } },
    create: { label: "current", deploymentId: deployment.id, environmentId: seed.environment.id },
    update: { deploymentId: deployment.id },
  });
}

async function setup(prisma: PrismaClient, suffix: string) {
  const seed = await seedTenant(prisma, suffix);
  await promote(prisma, seed, V2);
  const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  primaryHolder.client = prisma;
  storeHolder.store = writerStore;
  triggerState.calls.length = 0;
  cancelState.calls.length = 0;
  cancelState.failRunId = undefined;
  cancelState.onCancel = undefined;
  resolveState.calls.length = 0;
  resolveState.resolutions = { "ext-old": V1, "ext-new": V2 };
  peekState.calls.length = 0;
  peekState.result = true;
  peekState.backend = "s2";
  peekState.onPeek = undefined;
  waitState.calls.length = 0;
  waitState.ids = [];
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  triggerState.result = {
    run: { id: cuidRunId(`n${suffix}`), friendlyId: `run_${suffix}_new`, status: "PENDING" },
  };
  return { seed, writerStore };
}

async function createLiveRun(
  writerStore: PostgresRunStore,
  seed: Seed,
  suffix: string,
  taskVersion: string,
  ids: { runId?: string; friendlyId?: string } = {}
) {
  const runId = ids.runId ?? cuidRunId(`l${suffix}`);
  const friendlyId = ids.friendlyId ?? `run_${suffix}_live`;
  const input: CreateRunInput = {
    data: {
      id: runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId,
      runtimeEnvironmentId: seed.environment.id,
      environmentType: "PRODUCTION",
      organizationId: seed.organization.id,
      projectId: seed.project.id,
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
      createdAt: new Date(),
      taskVersion,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "EXECUTING_WITH_WAITPOINTS",
      description: "Waiting for the next message",
      runStatus: "EXECUTING",
      environmentId: seed.environment.id,
      environmentType: "PRODUCTION",
      projectId: seed.project.id,
      organizationId: seed.organization.id,
    },
  };
  await writerStore.createRun(input);
  return { runId, friendlyId };
}

async function createSession(
  prisma: PrismaClient,
  seed: Seed,
  suffix: string,
  p: { currentRunId?: string; triggerConfig?: Record<string, unknown>; externalId?: string }
) {
  return prisma.session.create({
    data: {
      friendlyId: `session_${suffix}`,
      externalId: p.externalId ?? null,
      type: "chat.agent",
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
      environmentType: "PRODUCTION",
      organizationId: seed.organization.id,
      taskIdentifier: "my-chat",
      triggerConfig: (p.triggerConfig ?? { basePayload: {} }) as never,
      currentRunId: p.currentRunId ?? null,
      currentRunVersion: 0,
    },
  });
}

async function createInWaitpoint(
  prisma: PrismaClient,
  seed: Seed,
  suffix: string,
  runId: string,
  status: "PENDING" | "COMPLETED" = "PENDING"
) {
  const waitpoint = await prisma.waitpoint.create({
    data: {
      friendlyId: `waitpoint_${suffix}_${seq++}`,
      type: "MANUAL",
      status,
      idempotencyKey: `idem_${suffix}_${seq++}`,
      userProvidedIdempotencyKey: false,
      projectId: seed.project.id,
      environmentId: seed.environment.id,
      connectedRuns: { connect: { id: runId } },
    },
  });
  waitState.ids.push(waitpoint.id);
  return waitpoint;
}

function lastTrigger() {
  const call = triggerState.calls.at(-1);
  return { payload: call?.body?.payload ?? {}, options: call?.body?.options ?? {} };
}

describe("session version floor — live runs", () => {
  postgresTest(
    "a pinned live run below minVersion is replaced by an unpinned continuation and cancelled",
    async ({ prisma }) => {
      const suffix = `floor_live_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
        triggerConfig: { basePayload: {}, lockToVersion: V1 },
      });
      const currentRunAtCancel: Array<string | null | undefined> = [];
      cancelState.onCancel = async () => {
        const row = await prisma.session.findFirst({ where: { id: session.id } });
        currentRunAtCancel.push(row?.currentRunId);
      };

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result.triggered).toBe(true);
      expect(result.runId).toBe(triggerState.result.run.id);
      expect(currentRunAtCancel).toEqual([live.runId]);
      expect(lastTrigger().payload).toMatchObject({
        continuation: true,
        previousRunId: live.friendlyId,
        sessionId: session.friendlyId,
      });
      expect(lastTrigger().options.lockToVersion).toBeUndefined();
      expect(cancelState.calls).toEqual([
        { runId: live.runId, friendlyId: live.friendlyId, reason: FLOOR_REASON },
      ]);
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.currentRunId).toBe(triggerState.result.run.id);
      expect(peekState.calls).toEqual([session.friendlyId]);
      expect(logger.info).toHaveBeenCalledWith(
        "Superseded a live run below the session version floor",
        {
          sessionId: session.id,
          runId: live.runId,
          taskVersion: V1,
          minVersion: V2,
          newRunId: triggerState.result.run.id,
        }
      );
    }
  );

  postgresTest("the idle peek reads the stream of the session's externalId", async ({ prisma }) => {
    const suffix = `floor_ext_${seq++}`;
    const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
    const live = await createLiveRun(writerStore, seed, suffix, V1);
    const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
      currentRunId: live.runId,
      externalId: `chat_${suffix}`,
    });

    const result = await ensureRunForSession({
      session,
      environment: environmentFor(seed, { minVersion: V2 }),
      reason: "continuation",
    });

    expect(result.triggered).toBe(true);
    expect(peekState.calls).toEqual([`chat_${suffix}`]);
  });

  postgresTest(
    "without the S2 backend a live run below minVersion is reused",
    async ({ prisma }) => {
      const suffix = `floor_nos2_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      peekState.backend = "other";
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: live.runId, triggered: false });
      expect(triggerState.calls).toHaveLength(0);
      expect(cancelState.calls).toHaveLength(0);
    }
  );

  postgresTest(
    "a failed cancel of the old run keeps it as the current run and cancels ours",
    async ({ prisma }) => {
      const suffix = `floor_cancelfail_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const ours = await createLiveRun(writerStore, seed, `${suffix}n`, V2, {
        runId: triggerState.result.run.id,
        friendlyId: triggerState.result.run.friendlyId,
      });
      cancelState.failRunId = live.runId;
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: live.runId, triggered: false });
      await vi.waitFor(() => expect(cancelState.calls).toHaveLength(1));
      expect(cancelState.calls).toEqual([
        {
          runId: ours.runId,
          friendlyId: ours.friendlyId,
          reason: "Superseded run could not be cancelled",
        },
      ]);
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.currentRunId).toBe(live.runId);
      expect(row?.currentRunVersion).toBe(0);
      expect(logger.info).not.toHaveBeenCalled();
    }
  );

  postgresTest(
    "a cancel that ends the old run and then throws still claims the new run",
    async ({ prisma }) => {
      const suffix = `floor_cancelhalf_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      cancelState.onCancel = async (runId) => {
        await prisma.taskRun.update({ where: { id: runId }, data: { status: "CANCELED" } });
        throw new Error("queue ack failed");
      };

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.currentRunId).toBe(triggerState.result.run.id);
    }
  );

  postgresTest(
    "a session closed between the idle check and the claim cancels the old run and ours",
    async ({ prisma }) => {
      const suffix = `floor_closed_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const old = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: old.runId,
      });
      const ours = await createLiveRun(writerStore, seed, `${suffix}n`, V2, {
        runId: triggerState.result.run.id,
        friendlyId: triggerState.result.run.friendlyId,
      });
      peekState.onPeek = async () => {
        await prisma.session.update({ where: { id: session.id }, data: { closedAt: new Date() } });
      };

      await expect(
        ensureRunForSession({
          session,
          environment: environmentFor(seed, { minVersion: V2 }),
          reason: "continuation",
        })
      ).rejects.toBeInstanceOf(SessionClosedError);

      expect(triggerState.calls).toHaveLength(1);
      await vi.waitFor(() => expect(cancelState.calls).toHaveLength(2));
      expect(cancelState.calls).toEqual([
        { runId: old.runId, friendlyId: old.friendlyId, reason: FLOOR_REASON },
        { runId: ours.runId, friendlyId: ours.friendlyId, reason: "Lost session-run claim race" },
      ]);
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.currentRunId).toBe(old.runId);
    }
  );

  postgresTest(
    "a lost claim after cancelling the old run cancels ours and reuses the winner's",
    async ({ prisma }) => {
      const suffix = `floor_lost_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const old = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: old.runId,
      });
      const winner = await createLiveRun(writerStore, seed, `${suffix}w`, V2);
      const loser = await createLiveRun(writerStore, seed, `${suffix}n`, V2, {
        runId: triggerState.result.run.id,
        friendlyId: triggerState.result.run.friendlyId,
      });
      await prisma.session.update({
        where: { id: session.id },
        data: { currentRunId: winner.runId, currentRunVersion: 1 },
      });

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: winner.runId, triggered: false });
      await vi.waitFor(() => expect(cancelState.calls).toHaveLength(2));
      expect(cancelState.calls).toEqual([
        { runId: old.runId, friendlyId: old.friendlyId, reason: FLOOR_REASON },
        {
          runId: loser.runId,
          friendlyId: loser.friendlyId,
          reason: "Lost session-run claim race",
        },
      ]);
    }
  );
});

describe("session version floor — current deployment below the floor", () => {
  postgresTest(
    "an idle run is reused with a warning, a busy run without one",
    async ({ prisma }) => {
      for (const idle of [true, false]) {
        const suffix = `floor_curbelow_${seq++}`;
        const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
        await promote(prisma as unknown as PrismaClient, seed, V1);
        peekState.result = idle;
        const live = await createLiveRun(writerStore, seed, suffix, V1);
        const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
          currentRunId: live.runId,
        });

        const result = await ensureRunForSession({
          session,
          environment: environmentFor(seed, { minVersion: V2 }),
          reason: "continuation",
        });

        expect(result).toMatchObject({ runId: live.runId, triggered: false });
        expect(triggerState.calls).toHaveLength(0);
        expect(cancelState.calls).toHaveLength(0);
        const warnings = vi
          .mocked(logger.warn)
          .mock.calls.filter(([message]) => message.startsWith("Current deployment is below"));
        expect(warnings.map(([, fields]) => fields)).toEqual(
          idle
            ? [
                {
                  sessionId: session.id,
                  runId: live.runId,
                  environmentId: seed.environment.id,
                  currentVersion: V1,
                  minVersion: V2,
                },
              ]
            : []
        );
        expect(logger.info).not.toHaveBeenCalled();
      }
    }
  );
});

describe("session version floor — runs that never write turn-complete", () => {
  postgresTest(
    "a run below minVersion waiting on its session's .in is superseded",
    async ({ prisma }) => {
      const suffix = `floor_inwait_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      peekState.result = false;
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
        externalId: `inbox_${suffix}`,
      });
      await createInWaitpoint(prisma as unknown as PrismaClient, seed, suffix, live.runId);

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result.triggered).toBe(true);
      expect(waitState.calls).toEqual([[`inbox_${suffix}`, "in"]]);
      expect(cancelState.calls).toEqual([
        { runId: live.runId, friendlyId: live.friendlyId, reason: FLOOR_REASON },
      ]);
    }
  );

  postgresTest(
    "a run below minVersion that is working, with no .in waitpoint, is reused",
    async ({ prisma }) => {
      const suffix = `floor_working_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      peekState.result = false;
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: live.runId, triggered: false });
      expect(waitState.calls).toEqual([[session.friendlyId, "in"]]);
      expect(triggerState.calls).toHaveLength(0);
      expect(cancelState.calls).toHaveLength(0);
    }
  );

  postgresTest(
    "a completed .in waitpoint left in the set does not count as waiting",
    async ({ prisma }) => {
      const suffix = `floor_staleinwait_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      peekState.result = false;
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      await createInWaitpoint(
        prisma as unknown as PrismaClient,
        seed,
        suffix,
        live.runId,
        "COMPLETED"
      );

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: live.runId, triggered: false });
      expect(cancelState.calls).toHaveLength(0);
    }
  );

  postgresTest(
    "a pending .in waitpoint that blocks another run does not count",
    async ({ prisma }) => {
      const suffix = `floor_otherinwait_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      peekState.result = false;
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const other = await createLiveRun(writerStore, seed, suffix, V1, {
        runId: cuidRunId(`o${suffix}`),
        friendlyId: `run_${suffix}_other`,
      });
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      await createInWaitpoint(prisma as unknown as PrismaClient, seed, suffix, other.runId);

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result).toMatchObject({ runId: live.runId, triggered: false });
      expect(cancelState.calls).toHaveLength(0);
    }
  );
});

describe("session version floor — pins", () => {
  postgresTest("a lockToVersion below minVersion is dropped for the run", async ({ prisma }) => {
    const suffix = `floor_lock_${seq++}`;
    const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
    const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
      triggerConfig: { basePayload: {}, lockToVersion: V1 },
    });

    await ensureRunForSession({
      session,
      environment: environmentFor(seed, { minVersion: V2 }),
      reason: "initial",
    });

    expect(lastTrigger().options.lockToVersion).toBeUndefined();
    const row = await prisma.session.findFirst({ where: { id: session.id } });
    expect(row?.triggerConfig).toMatchObject({ lockToVersion: V1 });
  });

  postgresTest("a lockToVersion at minVersion is kept", async ({ prisma }) => {
    const suffix = `floor_lockok_${seq++}`;
    const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
    const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
      triggerConfig: { basePayload: {}, lockToVersion: V2 },
    });

    await ensureRunForSession({
      session,
      environment: environmentFor(seed, { minVersion: V2 }),
      reason: "initial",
    });

    expect(lastTrigger().options.lockToVersion).toBe(V2);
  });

  postgresTest(
    "an externalDeploymentId below minVersion is dropped for the run",
    async ({ prisma }) => {
      const suffix = `floor_ext_old_${seq++}`;
      const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        triggerConfig: { basePayload: {}, lockToVersion: V1, externalDeploymentId: "ext-old" },
      });

      await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "initial",
      });

      expect(resolveState.calls).toEqual(["ext-old"]);
      expect(lastTrigger().options.lockToVersion).toBeUndefined();
      expect(lastTrigger().options.externalDeploymentId).toBeUndefined();
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.triggerConfig).toMatchObject({ externalDeploymentId: "ext-old" });
    }
  );

  postgresTest("an externalDeploymentId that would park the run is dropped", async ({ prisma }) => {
    const suffix = `floor_ext_park_${seq++}`;
    const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
    const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
      triggerConfig: { basePayload: {}, externalDeploymentId: "ext-missing" },
    });

    await ensureRunForSession({
      session,
      environment: environmentFor(seed, { minVersion: V2 }),
      reason: "initial",
    });

    expect(resolveState.calls).toEqual(["ext-missing"]);
    expect(lastTrigger().options.externalDeploymentId).toBeUndefined();
  });

  postgresTest("an externalDeploymentId at or above minVersion is kept", async ({ prisma }) => {
    const suffix = `floor_ext_new_${seq++}`;
    const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
    const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
      triggerConfig: { basePayload: {}, externalDeploymentId: "ext-new" },
    });

    await ensureRunForSession({
      session,
      environment: environmentFor(seed, { minVersion: V2 }),
      reason: "initial",
    });

    expect(lastTrigger().options.externalDeploymentId).toBe("ext-new");
  });

  postgresTest(
    "a lockToVersion at minVersion is kept without resolving externalDeploymentId",
    async ({ prisma }) => {
      const suffix = `floor_ext_lockok_${seq++}`;
      const { seed } = await setup(prisma as unknown as PrismaClient, suffix);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        triggerConfig: { basePayload: {}, lockToVersion: V2, externalDeploymentId: "ext-old" },
      });

      await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "initial",
      });

      expect(resolveState.calls).toHaveLength(0);
      expect(lastTrigger().options).toMatchObject({
        lockToVersion: V2,
        externalDeploymentId: "ext-old",
      });
    }
  );

  postgresTest(
    "the swap path drops an externalDeploymentId below minVersion",
    async ({ prisma }) => {
      const suffix = `floor_ext_swap_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
        triggerConfig: { basePayload: {}, externalDeploymentId: "ext-old" },
      });

      const result = await swapSessionRun({
        session,
        callingRunId: live.runId,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result.swapped).toBe(true);
      expect(lastTrigger().options.externalDeploymentId).toBeUndefined();
    }
  );

  postgresTest("the swap path drops a pin below minVersion too", async ({ prisma }) => {
    const suffix = `floor_swap_${seq++}`;
    const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
    const live = await createLiveRun(writerStore, seed, suffix, V1);
    const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
      currentRunId: live.runId,
      triggerConfig: { basePayload: {}, lockToVersion: V1 },
    });

    const result = await swapSessionRun({
      session,
      callingRunId: live.runId,
      environment: environmentFor(seed, { minVersion: V2 }),
      reason: "continuation",
    });

    expect(result.swapped).toBe(true);
    expect(lastTrigger().options.lockToVersion).toBeUndefined();
  });

  postgresTest("without a floor, pins and live runs behave as before", async ({ prisma }) => {
    const suffix = `floor_none_${seq++}`;
    const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
    const live = await createLiveRun(writerStore, seed, suffix, V1);
    const liveSession = await createSession(
      prisma as unknown as PrismaClient,
      seed,
      `${suffix}_l`,
      {
        currentRunId: live.runId,
      }
    );
    const reused = await ensureRunForSession({
      session: liveSession,
      environment: environmentFor(seed),
      reason: "continuation",
    });
    expect(reused).toMatchObject({ runId: live.runId, triggered: false });
    expect(triggerState.calls).toHaveLength(0);

    const pinnedSession = await createSession(
      prisma as unknown as PrismaClient,
      seed,
      `${suffix}_p`,
      {
        triggerConfig: { basePayload: {}, lockToVersion: V1 },
      }
    );
    await ensureRunForSession({
      session: pinnedSession,
      environment: environmentFor(seed),
      reason: "initial",
    });
    expect(lastTrigger().options.lockToVersion).toBe(V1);
    expect(cancelState.calls).toHaveLength(0);
    expect(peekState.calls).toHaveLength(0);

    const extSession = await createSession(prisma as unknown as PrismaClient, seed, `${suffix}_e`, {
      triggerConfig: { basePayload: {}, externalDeploymentId: "ext-old" },
    });
    triggerState.result = {
      run: { id: cuidRunId(`e${suffix}`), friendlyId: `run_${suffix}_ext`, status: "PENDING" },
    };
    await ensureRunForSession({
      session: extSession,
      environment: environmentFor(seed),
      reason: "initial",
    });
    expect(lastTrigger().options.externalDeploymentId).toBe("ext-old");
    expect(resolveState.calls).toHaveLength(0);
  });
});
