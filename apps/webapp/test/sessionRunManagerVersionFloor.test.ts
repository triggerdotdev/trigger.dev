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

// Set to make the replica's session reads return this row: a replica behind the writer.
const replicaState = vi.hoisted(() => ({ staleSession: undefined as unknown }));

const triggerState = vi.hoisted(() => ({
  calls: [] as Array<{ taskIdentifier: string; body: any; options: any }>,
  result: { run: { id: "", friendlyId: "", status: "PENDING" } } as {
    run: { id: string; friendlyId: string; status: string; taskVersion?: string };
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
    $replica: new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "session" && replicaState.staleSession) {
            return { findFirst: async () => replicaState.staleSession };
          }
          return (lazyProxy(primaryHolder, "primaryHolder.client") as any)[prop];
        },
      }
    ),
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
  onCancel: undefined as undefined | ((runId: string, reason?: string) => Promise<void>),
  // What the engine reports for an executing run: the worker was asked to stop, not stopped yet.
  pendingCancel: false,
}));

vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call(run: { id: string; friendlyId: string }, options?: { reason?: string }) {
      if (cancelState.failRunId === run.id) throw new Error("cancel failed");
      await cancelState.onCancel?.(run.id, options?.reason);
      cancelState.calls.push({
        runId: run.id,
        friendlyId: run.friendlyId,
        reason: options?.reason,
      });
      return { id: run.id, alreadyFinished: false, pendingCancel: cancelState.pendingCancel };
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
  sessionPinsInEffect,
  swapSessionRun,
} from "~/services/realtime/sessionRunManager.server";

// The current deployment is V2 in `setup`, so a superseded run moves to V2.
const movedReason = () =>
  `Moved to ${V2} by the skew protection threshold. Continued in ${triggerState.result.run.friendlyId}.`;
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

// `{ minVersion }` sets the environment's skew protection threshold; `taskMinVersions` sets
// thresholds for single tasks.
function environmentFor(
  seed: Seed,
  floor?: { minVersion: string },
  taskMinVersions: Record<string, string> = {}
) {
  const setAt = "2026-11-08T00:00:00.000Z";
  const tasks = Object.fromEntries(
    Object.entries(taskMinVersions).map(([task, version]) => [task, { version, setAt }])
  );
  return {
    id: seed.environment.id,
    type: "PRODUCTION",
    skewProtectionThresholds:
      floor || Object.keys(tasks).length > 0
        ? { ...(floor ? { environment: { version: floor.minVersion, setAt } } : {}), tasks }
        : null,
    organization: { streamBasinName: null, featureFlags: {} },
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
  replicaState.staleSession = undefined;
  cancelState.calls.length = 0;
  cancelState.failRunId = undefined;
  cancelState.onCancel = undefined;
  cancelState.pendingCancel = false;
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

async function writeSnapshot(
  writerStore: PostgresRunStore,
  seed: Seed,
  runId: string,
  executionStatus: "PENDING_CANCEL" | "FINISHED"
) {
  await writerStore.createExecutionSnapshot({
    run: { id: runId, status: "CANCELED" },
    snapshot: { executionStatus, description: "Run was cancelled" },
    environmentId: seed.environment.id,
    environmentType: "PRODUCTION",
    projectId: seed.project.id,
    organizationId: seed.organization.id,
  });
}

// What the worker's report of a cancelled attempt leaves: `completedAt` on the run, then the
// FINISHED snapshot.
async function finishCancelledRun(
  prisma: PrismaClient,
  writerStore: PostgresRunStore,
  seed: Seed,
  runId: string
) {
  await prisma.taskRun.update({ where: { id: runId }, data: { completedAt: new Date() } });
  await writeSnapshot(writerStore, seed, runId, "FINISHED");
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
        {
          runId: live.runId,
          friendlyId: live.friendlyId,
          reason: movedReason(),
        },
      ]);
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.currentRunId).toBe(triggerState.result.run.id);
      // Catches: the new run recorded as a plain continuation instead of a threshold move.
      const sessionRun = await prisma.sessionRun.findFirst({
        where: { runId: triggerState.result.run.id },
      });
      expect(sessionRun?.reason).toBe("skew-threshold");
      expect(peekState.calls).toEqual([session.friendlyId]);
      expect(logger.info).toHaveBeenCalledWith(
        "Superseded a live run below the session version floor",
        {
          sessionId: session.id,
          runId: live.runId,
          taskVersion: V1,
          minVersion: V2,
          newRunId: triggerState.result.run.id,
          pendingVersion: false,
        }
      );
    }
  );

  postgresTest(
    "a move kept on a pin at the threshold names the pinned version, not current",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const suffix = `floor_kept_pin_${seq++}`;
      const { seed, writerStore } = await setup(p, suffix);
      await promote(p, seed, "20261115.3");
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(p, seed, suffix, {
        currentRunId: live.runId,
        triggerConfig: { basePayload: {}, lockToVersion: V2 },
      });
      // A run locked to a version gets its taskVersion at trigger.
      triggerState.result = { run: { ...triggerState.result.run, taskVersion: V2 } };

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      expect(result.triggered).toBe(true);
      expect(lastTrigger().options.lockToVersion).toBe(V2);
      // Catches: the notice naming the current deployment while the replacement runs the pin.
      expect(cancelState.calls).toEqual([
        {
          runId: live.runId,
          friendlyId: live.friendlyId,
          reason: `Moved to ${V2} by the skew protection threshold. Continued in ${triggerState.result.run.friendlyId}.`,
        },
      ]);
    }
  );

  postgresTest(
    "a threshold for one task moves that task's sessions and no other's",
    async ({ prisma }) => {
      const suffix = `floor_task_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
        triggerConfig: { basePayload: {}, lockToVersion: V1 },
      });

      // Catches: another task's threshold moving this session (its task is "my-chat").
      const untouched = await ensureRunForSession({
        session,
        environment: environmentFor(seed, undefined, { "other-chat": V2 }),
        reason: "continuation",
      });
      expect(untouched).toMatchObject({ runId: live.runId, triggered: false });
      expect(cancelState.calls).toEqual([]);

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, undefined, { "my-chat": V2 }),
        reason: "continuation",
      });

      expect(result.triggered).toBe(true);
      expect(lastTrigger().options.lockToVersion).toBeUndefined();
      // Catches: the cancel reason and the run page not saying which threshold moved the session.
      expect(cancelState.calls).toEqual([
        {
          runId: live.runId,
          friendlyId: live.friendlyId,
          reason: `Moved to ${V2} by the skew protection threshold for my-chat. Continued in ${triggerState.result.run.friendlyId}.`,
        },
      ]);
      const sessionRun = await prisma.sessionRun.findFirst({
        where: { runId: triggerState.result.run.id },
      });
      expect(sessionRun?.reason).toBe("skew-threshold");
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
      // Catches: the claim going ahead without waiting for the old warm run to stop, so both runs
      // answered the next message.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("superseded session run"),
        expect.objectContaining({ runId: live.runId, hitCap: true })
      );
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
        {
          runId: old.runId,
          friendlyId: old.friendlyId,
          reason: movedReason(),
        },
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
        {
          runId: old.runId,
          friendlyId: old.friendlyId,
          reason: movedReason(),
        },
        {
          runId: loser.runId,
          friendlyId: loser.friendlyId,
          reason: "Lost session-run claim race",
        },
      ]);
    }
  );
});

describe("session version floor — a cancelled warm run stops before the move returns", () => {
  postgresTest(
    "waits for the old run's execution to finish before claiming the new run",
    async ({ prisma }) => {
      const suffix = `floor_stop_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      let returned = false;
      let finished:
        | Promise<{ returnedBeforeStop: boolean; currentRunId?: string | null }>
        | undefined;
      cancelState.pendingCancel = true;
      cancelState.onCancel = async (runId) => {
        await writeSnapshot(writerStore, seed, runId, "PENDING_CANCEL");
        // The worker reports the attempt a little later, as a real cancel ack does.
        finished = new Promise((resolve) => setTimeout(resolve, 300)).then(async () => {
          const returnedBeforeStop = returned;
          const row = await prisma.session.findFirst({ where: { id: session.id } });
          await finishCancelledRun(prisma as unknown as PrismaClient, writerStore, seed, runId);
          return { returnedBeforeStop, currentRunId: row?.currentRunId };
        });
      };

      const snapshotRead = vi.spyOn(writerStore, "findLatestExecutionSnapshot");

      const startedAt = performance.now();
      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });
      returned = true;
      const elapsedMs = performance.now() - startedAt;

      expect(result).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      // Catches: the move returning (and the caller appending) while the old process can still read `.in`.
      expect(finished).toBeDefined();
      await expect(finished).resolves.toEqual({
        returnedBeforeStop: false,
        currentRunId: live.runId,
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(300);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(logger.warn).not.toHaveBeenCalled();
      // Catches: each poll loading the whole latest snapshot (waitpoints, checkpoint) for one flag.
      expect(snapshotRead).not.toHaveBeenCalled();
      // Catches: cancel ack times invisible in production, so the cap can't be chosen from them.
      expect(logger.info).toHaveBeenCalledWith(
        "Waited for a superseded session run to stop",
        expect.objectContaining({
          sessionId: session.id,
          runId: live.runId,
          hitCap: false,
          capMs: 5_000,
          waitedMs: expect.any(Number),
        })
      );
      const waitedMs = vi
        .mocked(logger.info)
        .mock.calls.find(
          ([message]) => message === "Waited for a superseded session run to stop"
        )?.[1]?.waitedMs as number;
      expect(waitedMs).toBeGreaterThanOrEqual(300);
      expect(waitedMs).toBeLessThan(2_000);
    }
  );

  postgresTest(
    "gives up after about five seconds and still moves the session",
    async ({ prisma }) => {
      const suffix = `floor_stop_timeout_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      cancelState.pendingCancel = true;
      cancelState.onCancel = (runId) => writeSnapshot(writerStore, seed, runId, "PENDING_CANCEL");

      const startedAt = performance.now();
      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });
      const elapsedMs = performance.now() - startedAt;

      // Catches: a worker that never acks the cancel blocking the append forever.
      expect(result).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(elapsedMs).toBeLessThan(6_500);
      expect(logger.warn).toHaveBeenCalledWith(
        "Waited for a superseded session run to stop",
        expect.objectContaining({ sessionId: session.id, runId: live.runId, hitCap: true })
      );
      const row = await prisma.session.findFirst({ where: { id: session.id } });
      expect(row?.currentRunId).toBe(triggerState.result.run.id);
    }
  );

  postgresTest(
    "doesn't wait when the cancel finished the run straight away (a suspended run)",
    async ({ prisma }) => {
      const suffix = `floor_stop_suspended_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      // The run never gets a completedAt here, so any wait would run to the timeout.
      cancelState.pendingCancel = false;

      const startedAt = performance.now();
      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      // Catches: every move paying the wait, including runs with no process left to stop.
      expect(result).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );
});

// What the engine's cancel leaves on a run: CANCELED with the reason.
async function markCancelled(prisma: PrismaClient, runId: string, reason: string) {
  await prisma.taskRun.update({
    where: { id: runId },
    data: { status: "CANCELED", error: { type: "STRING_ERROR", raw: reason } },
  });
}

describe("session version floor — a second append while a move waits", () => {
  postgresTest(
    "waits for the first append's claim and reuses its run without triggering",
    async ({ prisma }) => {
      const suffix = `floor_second_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      const environment = environmentFor(seed, { minVersion: V2 });
      // The trigger is mocked, so the row of the run it returns is written here.
      await createLiveRun(writerStore, seed, suffix, V2, {
        runId: triggerState.result.run.id,
        friendlyId: triggerState.result.run.friendlyId,
      });
      let cancelled!: () => void;
      const firstCancelled = new Promise<void>((resolve) => (cancelled = resolve));
      cancelState.pendingCancel = true;
      cancelState.onCancel = async (runId, reason) => {
        await markCancelled(prisma as unknown as PrismaClient, runId, reason ?? "");
        await writeSnapshot(writerStore, seed, runId, "PENDING_CANCEL");
        cancelled();
        // The worker reports the attempt a little later, as a real cancel ack does.
        setTimeout(
          () =>
            void finishCancelledRun(prisma as unknown as PrismaClient, writerStore, seed, runId),
          400
        );
      };

      const first = ensureRunForSession({ session, environment, reason: "continuation" });
      await firstCancelled;
      let firstReturned = false;
      void first.then(() => (firstReturned = true));
      // The second append read the session before the first one claimed.
      const second = await ensureRunForSession({ session, environment, reason: "continuation" });
      const firstReturnedBeforeSecond = firstReturned;

      // Catches: the second append taking the dead-run path while the first waits: its own run,
      // no wait, and its message read by the old process.
      expect(second).toEqual({
        runId: triggerState.result.run.id,
        triggered: false,
        pendingVersion: false,
      });
      expect(firstReturnedBeforeSecond).toBe(true);
      expect(await first).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      expect(triggerState.calls).toHaveLength(1);
      expect(cancelState.calls.map((call) => call.runId)).toEqual([live.runId]);
      const rows = await prisma.sessionRun.findMany({ where: { sessionId: session.id } });
      expect(rows.map((row) => row.reason)).toEqual(["skew-threshold"]);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );

  postgresTest(
    "starts its own run when the move never claims (the first request died)",
    async ({ prisma }) => {
      const suffix = `floor_second_dead_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      // The run the dead request triggered and never claimed.
      const orphan = await createLiveRun(writerStore, seed, `${suffix}o`, V2);
      await markCancelled(
        prisma as unknown as PrismaClient,
        live.runId,
        `Moved to ${V2} by the skew protection threshold. Continued in ${orphan.friendlyId}.`
      );

      const startedAt = performance.now();
      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });
      const elapsedMs = performance.now() - startedAt;

      // Catches: the dead request's run left waiting on `.in` beside the new one, both answering.
      await vi.waitFor(() =>
        expect(cancelState.calls.map((call) => call.runId)).toContain(orphan.runId)
      );
      // Catches: a move whose request died leaving the session without a run for good.
      expect(result).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      // Longer than the first append's own wait (5 s), so it can't give up before that one claims.
      expect(elapsedMs).toBeGreaterThanOrEqual(5_500);
      expect(elapsedMs).toBeLessThan(7_000);
      expect(logger.warn).toHaveBeenCalledWith(
        "A session move in flight didn't claim its run in time; starting a new run",
        expect.objectContaining({ sessionId: session.id, runId: live.runId })
      );
      expect(lastTrigger().payload).toMatchObject({
        continuation: true,
        previousRunId: live.friendlyId,
      });
    }
  );

  postgresTest(
    "reuses the move's run when only the writer shows its claim at the deadline",
    async ({ prisma }) => {
      const suffix = `floor_second_lag_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      // The first append moved the session and claimed on the writer; the replica never caught up.
      const successor = await createLiveRun(writerStore, seed, `${suffix}s`, V2);
      await markCancelled(
        prisma as unknown as PrismaClient,
        live.runId,
        `Moved to ${V2} by the skew protection threshold. Continued in ${successor.friendlyId}.`
      );
      await prisma.session.update({
        where: { id: session.id },
        data: { currentRunId: successor.runId, currentRunVersion: { increment: 1 } },
      });
      replicaState.staleSession = session;

      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      // Catches: the timeout cancelling the run that already owns the session, leaving the session
      // pointing at a cancelled run.
      expect(result).toEqual({ runId: successor.runId, triggered: false, pendingVersion: false });
      expect(cancelState.calls).toEqual([]);
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  postgresTest(
    "two appends that both saw the old run live: the one whose cancel lost waits for the other",
    async ({ prisma }) => {
      const suffix = `floor_second_both_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      const environment = environmentFor(seed, { minVersion: V2 });
      await createLiveRun(writerStore, seed, suffix, V2, {
        runId: triggerState.result.run.id,
        friendlyId: triggerState.result.run.friendlyId,
      });
      // The other append's run: its cancel of the old run landed first, so its reason stands.
      const other = await createLiveRun(writerStore, seed, `${suffix}o`, V2);
      cancelState.onCancel = async (runId) => {
        if (runId !== live.runId) return;
        await markCancelled(
          prisma as unknown as PrismaClient,
          live.runId,
          `Moved to ${V2} by the skew protection threshold. Continued in ${other.friendlyId}.`
        );
        // That append claims after its own stop wait.
        // A Prisma query runs only once awaited.
        setTimeout(async () => {
          await prisma.session.update({
            where: { id: session.id },
            data: { currentRunId: other.runId, currentRunVersion: { increment: 1 } },
          });
        }, 300);
      };

      const result = await ensureRunForSession({ session, environment, reason: "continuation" });

      // Catches: both appends claiming in a race, so the "Session moved" notice on the old run can
      // link a run that lost the claim and was cancelled.
      expect(result).toEqual({ runId: other.runId, triggered: false, pendingVersion: false });
      await vi.waitFor(() =>
        expect(cancelState.calls.map((call) => call.runId)).toEqual([
          live.runId,
          triggerState.result.run.id,
        ])
      );
      expect(await prisma.sessionRun.count({ where: { sessionId: session.id } })).toBe(0);
    }
  );

  postgresTest(
    "a run cancelled for another reason is replaced straight away",
    async ({ prisma }) => {
      const suffix = `floor_second_user_${seq++}`;
      const { seed, writerStore } = await setup(prisma as unknown as PrismaClient, suffix);
      const live = await createLiveRun(writerStore, seed, suffix, V1);
      const session = await createSession(prisma as unknown as PrismaClient, seed, suffix, {
        currentRunId: live.runId,
      });
      await markCancelled(prisma as unknown as PrismaClient, live.runId, "Canceled by user");

      const startedAt = performance.now();
      const result = await ensureRunForSession({
        session,
        environment: environmentFor(seed, { minVersion: V2 }),
        reason: "continuation",
      });

      // Catches: every append after a user's cancel waiting for a claim nobody is going to make.
      expect(result).toMatchObject({ runId: triggerState.result.run.id, triggered: true });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );
});

describe("session version floor — current deployment below the floor", () => {
  postgresTest(
    "an idle run is reused with a warning, a busy run with an info line",
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
        // Catches: a busy run keeping its session with nothing in the logs to say why.
        expect(vi.mocked(logger.info).mock.calls).toEqual(
          idle
            ? []
            : [
                [
                  "Kept a run below the skew protection threshold: busy",
                  {
                    sessionId: session.id,
                    runId: live.runId,
                    environmentId: seed.environment.id,
                    taskVersion: V1,
                    minVersion: V2,
                    thresholdTask: undefined,
                  },
                ],
              ]
        );
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
        {
          runId: live.runId,
          friendlyId: live.friendlyId,
          reason: movedReason(),
        },
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

  // Catches: session retrieve returning a pin the server ignores, so an agent that follows the
  // pin asked for the old deployment on every turn and was started on the current one again.
  postgresTest("the pins in effect leave out a pin below minVersion", async ({ prisma }) => {
    const { seed } = await setup(prisma as unknown as PrismaClient, `floor_ext_effect_${seq++}`);
    const below = { basePayload: {}, externalDeploymentId: "ext-old" };
    const above = { basePayload: {}, externalDeploymentId: "ext-new" };

    expect(
      await sessionPinsInEffect(below, environmentFor(seed, { minVersion: V2 }), "chat")
    ).toEqual({ basePayload: {}, externalDeploymentId: undefined });
    expect(await sessionPinsInEffect(above, environmentFor(seed, { minVersion: V2 }), "chat")).toBe(
      above
    );
    expect(await sessionPinsInEffect(below, environmentFor(seed), "chat")).toBe(below);
  });

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

  // Catches: any token that can write the session (a browser's public session token) labelling a
  // swap as a threshold move, or forcing a move past the session's lockToVersion pin, by sending
  // reason "skew-threshold" to end-and-continue.
  postgresTest(
    "a skew-threshold swap from a caller is recorded as manual and keeps the session's pin",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const suffix = `floor_forged_${seq++}`;
      const { seed, writerStore } = await setup(p, suffix);
      const swap = async (n: number, environment: AuthenticatedEnvironment, runVersion: string) => {
        const live = await createLiveRun(writerStore, seed, `${suffix}${n}`, runVersion);
        const session = await createSession(p, seed, `${suffix}${n}`, {
          currentRunId: live.runId,
          triggerConfig: { basePayload: {}, lockToVersion: V1 },
        });
        const result = await swapSessionRun({
          session,
          callingRunId: live.runId,
          environment,
          reason: "skew-threshold",
        });
        const row = await p.sessionRun.findFirst({
          where: { sessionId: session.id },
          select: { reason: true },
        });
        return { swapped: result.swapped, reason: row?.reason };
      };

      // No threshold at all.
      expect(await swap(1, environmentFor(seed), V1)).toEqual({ swapped: true, reason: "manual" });
      expect(lastTrigger().options.lockToVersion).toBe(V1);

      // A threshold the calling run already meets.
      triggerState.result = {
        run: { id: cuidRunId(`f${suffix}`), friendlyId: `run_${suffix}_f`, status: "PENDING" },
      };
      expect(await swap(2, environmentFor(seed, { minVersion: V1 }), V1)).toEqual({
        swapped: true,
        reason: "manual",
      });
      expect(lastTrigger().options.lockToVersion).toBe(V1);
    }
  );

  // Catches: the route's replica read of the session lagging one claim behind the writer making
  // the swap lose its own claim while the calling run is still current: the new run was cancelled
  // and the old run exited believing someone else took over, so the reply stalled.
  postgresTest("a swap from a session read one claim behind still claims", async ({ prisma }) => {
    const p = prisma as unknown as PrismaClient;
    const suffix = `floor_stale_${seq++}`;
    const { seed, writerStore } = await setup(p, suffix);
    const live = await createLiveRun(writerStore, seed, suffix, V1);
    const stale = await createSession(p, seed, suffix, { currentRunId: live.runId });
    await p.session.update({ where: { id: stale.id }, data: { currentRunVersion: 1 } });

    const result = await swapSessionRun({
      session: stale,
      callingRunId: live.runId,
      environment: environmentFor(seed),
      reason: "upgrade",
    });

    expect(result).toMatchObject({ runId: triggerState.result.run.id, swapped: true });
    expect(
      await p.session.findFirst({
        where: { id: stale.id },
        select: { currentRunId: true, currentRunVersion: true },
      })
    ).toEqual({ currentRunId: triggerState.result.run.id, currentRunVersion: 2 });
    expect(cancelState.calls).toHaveLength(0);
  });

  postgresTest(
    "a handoff right after an upgrade, read one claim behind, builds from the stored config",
    async ({ prisma }) => {
      const p = prisma as unknown as PrismaClient;
      const suffix = `floor_stale_cfg_${seq++}`;
      const { seed, writerStore } = await setup(p, suffix);
      const first = await createLiveRun(writerStore, seed, suffix, V1);
      const stale = await createSession(p, seed, suffix, { currentRunId: first.runId });
      // An upgrade handed the session to `second` with a new pin; the replica still shows `first`.
      const second = await createLiveRun(writerStore, seed, `${suffix}s`, V2);
      const newer = { basePayload: { restarted: true }, externalDeploymentId: "ext-mid" };
      await p.session.update({
        where: { id: stale.id },
        data: { currentRunId: second.runId, currentRunVersion: 1, triggerConfig: newer },
      });

      // `second` asks for another handoff before the replica catches up.
      const result = await swapSessionRun({
        session: stale,
        callingRunId: second.runId,
        environment: environmentFor(seed),
        reason: "upgrade",
        externalDeploymentId: "ext-new",
      });

      // Catches: the replica's config written over the newer one, a handoff the calling run still
      // owns refused, or a second continuation triggered while the first may be booting.
      expect(result).toMatchObject({ runId: triggerState.result.run.id, swapped: true });
      expect(triggerState.calls).toHaveLength(1);
      expect(cancelState.calls).toEqual([]);
      expect(
        await p.session.findFirst({
          where: { id: stale.id },
          select: { currentRunId: true, triggerConfig: true },
        })
      ).toEqual({
        currentRunId: triggerState.result.run.id,
        triggerConfig: { basePayload: { restarted: true }, externalDeploymentId: "ext-new" },
      });
      expect(lastTrigger().payload).toMatchObject({ restarted: true });
    }
  );

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
