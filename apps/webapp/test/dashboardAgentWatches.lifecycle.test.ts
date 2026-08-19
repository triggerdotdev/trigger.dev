import {
  getWatch,
  listActiveWatchesForChat,
  recordWatchCheck,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { previousCheckFacts } from "~/services/dashboardAgentWatchChecks";
import {
  BACKLOG,
  DashboardAgentWatchesTestHarness,
  RUN_START,
  readRunOnce,
  type DashboardAgentWatchesTestContext,
} from "./helpers/dashboardAgentWatchesTestHelpers";

vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(
  (): DashboardAgentWatchesTestContext => ({
    prisma: undefined as unknown as PrismaClient,
    agentDb: undefined as unknown as DashboardAgentDb,
    canAccess: true,
    actor: undefined,
    triggered: [],
  })
);

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => ctx.canAccess,
}));

process.env.SESSION_SECRET = "test-session-secret-for-watch-tokens";

const { authorizeWatchEnvironment, createDashboardAgentWatch, listActiveWatchesForChats } =
  await import("~/services/dashboardAgentWatches.server");

const harness = new DashboardAgentWatchesTestHarness(ctx, createDashboardAgentWatch);
const boot = harness.boot.bind(harness);
const seed = harness.seed.bind(harness);
const seedChat = harness.seedChat.bind(harness);
const runRow = harness.runRow.bind(harness);
const create = harness.create.bind(harness);

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe("createDashboardAgentWatch", () => {
  postgresTest(
    "creates an active watch and schedules its first tick",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const scheduled: Array<{ watchId: string; token: string; tick: number }> = [];
      const result = await create({ seeded, scheduled });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe("active");
      expect(result.identity).toBe("run_start:run_1");
      expect(result.immediate).toBeUndefined();

      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.watchId).toBe(result.watchId);
      expect(scheduled[0]!.tick).toBe(1);
      expect(scheduled[0]!.token.startsWith("tr_daw_")).toBe(true);

      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      expect(row).toMatchObject({
        status: "active",
        deliveryStatus: "not_required",
        environmentId: seeded.environment.id,
        projectId: seeded.project.id,
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        tickCount: 0,
        investigateOnAttention: false,
        projectRef: seeded.project.externalRef,
      });
    }
  );

  postgresTest(
    "records the investigate-on-attention consent when the caller asks for it",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({ seeded, investigateOnAttention: true });

      expect(result.ok).toBe(true);
      if (!result.ok || !result.watching) return;
      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      expect(row?.investigateOnAttention).toBe(true);
      expect(result.identity).toBe("run_start:run_1");
    }
  );

  postgresTest(
    "stamps a server-set `since` on an error_recurrence watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const before = Date.now();
      const result = await create({
        seeded,
        spec: {
          kind: "error_recurrence",
          fingerprint: "fp_1",
          checkEveryMinutes: 5,
          maxHours: 2,
          note: "tell me if it comes back",
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      const since = (row?.spec as { since?: string } | undefined)?.since;
      expect(since).toBeDefined();
      expect(new Date(since!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
  );

  postgresTest(
    "answers with a one-shot result and writes no row when the condition already holds",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      let ticks = 0;
      const result = await create({
        seeded,
        checkDeps: {
          readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }),
        },
        onSchedule: () => {
          ticks += 1;
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok || result.watching) throw new Error("expected a one-shot result");
      expect(result.immediate.result).toBe("satisfied");
      expect(result.immediate.observed).toMatchObject({ kind: "run_start", started: true });
      expect(ticks).toBe(0);

      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
      expect(
        await listActiveWatchesForChats({
          chatIds: ["chat_1"],
          organizationId: seeded.organization.id,
          userId: seeded.user.id,
        })
      ).toEqual({});
    }
  );

  postgresTest(
    "answers with a one-shot result when the condition can no longer happen",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({
        seeded,
        checkDeps: { readRun: readRunOnce(runRow({ status: "QUEUED" })) },
      });

      expect(result.ok).toBe(true);
      if (!result.ok || result.watching) throw new Error("expected a one-shot result");
      expect(result.immediate.result).toBe("terminal_unsatisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "refuses a duplicate before running the immediate check",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const first = await create({ seeded });
      expect(first.ok).toBe(true);

      let checks = 0;
      const second = await create({
        seeded,
        checkDeps: {
          readRun: async () => {
            checks += 1;
            return runRow({ status: "EXECUTING", startedAt: new Date() });
          },
        },
      });

      expect(second).toMatchObject({ ok: false, code: "duplicate" });
      expect(checks).toBe(1);
    }
  );

  postgresTest(
    "cancels the row silently when the first tick can't be scheduled",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({
        seeded,
        onSchedule: () => {
          throw new Error("no agent project");
        },
      });

      expect(result).toMatchObject({ ok: false, code: "internal" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
      const rows = await ctx.prisma.$queryRawUnsafe<
        { status: string; cancel_reason: string; delivery_status: string }[]
      >(
        `select status, cancel_reason, delivery_status
         from trigger_dashboard_agent.watches where chat_id = 'chat_1'`
      );
      expect(rows).toMatchObject([
        {
          status: "cancelled",
          cancel_reason: "scheduling_failed",
          delivery_status: "not_required",
        },
      ]);
    }
  );

  postgresTest(
    "rejects a target that doesn't exist, writing nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({
        seeded,
        spec: BACKLOG,
        checkDeps: { queueExists: async () => false },
      });

      expect(result).toMatchObject({ ok: false, code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "dedups the same condition and allows it in another environment",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const first = await create({ seeded });
      expect(first.ok).toBe(true);

      const second = await create({ seeded });
      expect(second).toMatchObject({ ok: false, code: "duplicate" });
      if (!second.ok && first.ok) expect(second.existingId).toBe(first.watchId);

      const otherEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "stg",
          type: "STAGING",
          projectId: seeded.project.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_stg_${seeded.project.slug}`,
          pkApiKey: `pk_stg_${seeded.project.slug}`,
          shortcode: `s${seeded.project.slug.slice(0, 6)}`,
        },
      });
      const third = await create({ seeded, environmentId: otherEnv.id });
      expect(third.ok).toBe(true);
    }
  );

  postgresTest(
    "refuses a 4th active watch in the same chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      for (const runId of ["run_1", "run_2", "run_3"]) {
        const created = await create({ seeded, spec: { ...RUN_START, runId } });
        expect(created.ok).toBe(true);
      }

      const fourth = await create({ seeded, spec: { ...RUN_START, runId: "run_4" } });
      expect(fourth).toMatchObject({ ok: false, code: "limit_reached" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(3);
    }
  );

  postgresTest(
    "holds the ≤3 limit against four concurrent creates",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "race");
      await seedChat(seeded);

      const results = await Promise.all(
        ["run_1", "run_2", "run_3", "run_4"].map((runId) =>
          create({ seeded, spec: { ...RUN_START, runId } })
        )
      );

      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(
        results.filter((result) => !result.ok && result.code === "limit_reached")
      ).toHaveLength(1);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(3);
    }
  );
});

describe("authorizeWatchEnvironment", () => {
  postgresTest(
    "passes for a member and fails once membership is gone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "auth");

      const params = {
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
      };

      expect((await authorizeWatchEnvironment(params)).ok).toBe(true);

      await prisma.orgMember.deleteMany({ where: { userId: seeded.user.id } });
      expect(await authorizeWatchEnvironment(params)).toEqual({
        ok: false,
        reason: "access_revoked",
      });
    }
  );

  postgresTest("fails when the feature gate is revoked", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "auth");
    ctx.canAccess = false;

    expect(
      await authorizeWatchEnvironment({
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
      })
    ).toEqual({ ok: false, reason: "access_revoked" });
  });

  postgresTest(
    "fails when the snapshot names a different project",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "auth");
      const other = await seed(prisma, "other");

      expect(
        await authorizeWatchEnvironment({
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
          projectId: other.project.id,
          environmentId: seeded.environment.id,
        })
      ).toEqual({ ok: false, reason: "access_revoked" });
    }
  );
});

describe("run_failed creation", () => {
  const RUN_FAILED: WatchSpec = {
    kind: "run_failed",
    runId: "run_1",
    checkEveryMinutes: 1,
    maxHours: 2,
    note: "tell me if it fails",
  };

  postgresTest(
    "watches a running run and dedups against the finished variant separately",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "runfailed");
      await seedChat(seeded);

      const failed = await create({
        seeded,
        spec: RUN_FAILED,
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING" }) },
      });
      expect(failed.ok).toBe(true);
      if (!failed.ok || !failed.watching) return;
      expect(failed.identity).toBe("run_failed:run_1");

      const finished = await create({
        seeded,
        spec: { ...RUN_FAILED, kind: "run_finished" } as WatchSpec,
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING" }) },
      });
      expect(finished.ok).toBe(true);
      if (!finished.ok || !finished.watching) return;
      expect(finished.identity).toBe("run_finished:run_1");
    }
  );

  postgresTest(
    "answers outright, with no watch row, once the run has succeeded",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "runfailed-done");
      await seedChat(seeded);

      const result = await create({
        seeded,
        spec: RUN_FAILED,
        checkDeps: {
          readRun: async () =>
            runRow({ status: "COMPLETED_SUCCESSFULLY", completedAt: new Date() }),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(false);
      if (result.watching) return;
      expect(result.immediate.result).toBe("terminal_unsatisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );
});

describe("the queue pack creation", () => {
  const QUEUE = "task/my-task";

  const BELOW: WatchSpec = {
    kind: "queue_depth_below",
    queue: QUEUE,
    threshold: 100,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me when it's back below 100",
  };

  const STALLED: WatchSpec = {
    kind: "queue_stalled",
    queue: QUEUE,
    ticks: 3,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me if it stops moving",
  };

  const AGE: WatchSpec = {
    kind: "queue_oldest_age",
    queue: QUEUE,
    thresholdMinutes: 5,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me if runs wait longer than 5 minutes",
  };

  postgresTest(
    "creates each kind with its own identity on the same queue",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queuepack");
      await seedChat(seeded);

      const busy = {
        readQueueDepth: async () => ({
          depth: 780,
          source: "live_queue" as const,
          current: true,
        }),
      };

      const below = await create({ seeded, spec: BELOW, checkDeps: busy });
      expect(below.ok && below.watching).toBe(true);
      if (!below.ok || !below.watching) return;
      expect(below.identity).toBe(`queue_depth_below:${QUEUE}:100`);

      const stalled = await create({ seeded, spec: STALLED, checkDeps: busy });
      expect(stalled.ok && stalled.watching).toBe(true);
      if (!stalled.ok || !stalled.watching) return;
      expect(stalled.identity).toBe(`queue_stalled:${QUEUE}`);

      const age = await create({ seeded, spec: AGE, checkDeps: busy });
      expect(age.ok && age.watching).toBe(true);
      if (!age.ok || !age.watching) return;
      expect(age.identity).toBe(`queue_oldest_age:${QUEUE}:5`);

      const drain = await create({
        seeded,
        spec: { ...BELOW, kind: "backlog_drain" } as WatchSpec,
        checkDeps: busy,
      });
      expect(drain.ok).toBe(false);
      if (drain.ok) return;
      expect(drain.code).toBe("limit_reached");
    }
  );

  postgresTest(
    "dedups the same SLA and allows a different one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queueage");
      await seedChat(seeded);

      const first = await create({ seeded, spec: AGE });
      expect(first.ok && first.watching).toBe(true);

      const same = await create({ seeded, spec: AGE });
      expect(same.ok).toBe(false);
      if (same.ok) return;
      expect(same.code).toBe("duplicate");

      const other = await create({ seeded, spec: { ...AGE, thresholdMinutes: 30 } as WatchSpec });
      expect(other.ok && other.watching).toBe(true);
      if (!other.ok || !other.watching) return;
      expect(other.identity).toBe(`queue_oldest_age:${QUEUE}:30`);
    }
  );

  postgresTest(
    "answers a back-below ask outright when the queue is already quiet",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queuebelow");
      await seedChat(seeded);

      const result = await create({
        seeded,
        spec: BELOW,
        checkDeps: {
          readQueueDepth: async () => ({ depth: 4, source: "live_queue", current: true }),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(false);
      if (result.watching) return;
      expect(result.immediate.result).toBe("satisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );

  postgresTest(
    "round-trips the stall state through the row's existing facts column",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queuestall");
      await seedChat(seeded);

      const created = await create({
        seeded,
        spec: STALLED,
        checkDeps: {
          readQueueDepth: async () => ({ depth: 42, source: "live_queue", current: true }),
        },
      });
      expect(created.ok && created.watching).toBe(true);
      if (!created.ok || !created.watching) return;

      const facts = { queue: QUEUE, depth: 42, notDecreasingStreak: 2, ticks: 3 };
      await recordWatchCheck(ctx.agentDb, {
        id: created.watchId,
        lastResult: {
          result: "pending",
          facts,
          observed: {
            kind: "queue_stalled",
            verified: true,
            depth: 42,
            notDecreasingStreak: 2,
            ticks: 3,
          },
          final: false,
        },
      });

      const row = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(previousCheckFacts(row?.lastResult)).toEqual(facts);

      await recordWatchCheck(ctx.agentDb, {
        id: created.watchId,
        lastResult: { checkFailed: true, detail: "clickhouse down", previous: facts },
      });
      const afterGap = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(previousCheckFacts(afterGap?.lastResult)).toEqual(facts);
    }
  );
});
