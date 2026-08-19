import {
  createChat,
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
  type Seeded,
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

vi.mock("~/services/uatRoutePreamble.server", () => ({
  authenticateUatOrApiRequest: async () =>
    ctx.actor
      ? {
          authenticationResult: {
            type: "personalAccessToken",
            result: { userId: ctx.actor.userId },
          },
          userActor: ctx.actor,
        }
      : undefined,
}));

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

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TriggerClient: class {
      tasks = {
        trigger: async (taskId: string) => {
          ctx.triggered.push(taskId);
          return { id: "run_test" };
        },
      };
    },
  };
});

const SESSION_SECRET = "test-session-secret-for-watch-tokens";
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";
process.env.DASHBOARD_AGENT_SECRET_KEY = "test-dashboard-agent-secret";

const { authorizeWatchEnvironment, createDashboardAgentWatch, listActiveWatchesForChats } =
  await import("~/services/dashboardAgentWatches.server");
const { action: checkAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.$watchId.check");
const { action: createAction } = await import("~/routes/api.v1.dashboard-agent.watches");
const { signDashboardAgentWatchToken } = await import("~/services/dashboardAgentWatchToken.server");
const { loader: alertsLoader, action: alertsAction } =
  await import("~/routes/api.v1.dashboard-agent.alerts");
const { action: alertChannelAction } =
  await import("~/routes/api.v1.dashboard-agent.alerts.$channelId");
const { findProjectBySlug } = await import("~/models/project.server");
const { DASHBOARD_AGENT_WATCH_ALERT_TYPE } =
  await import("~/services/dashboardAgentWatchAlerts.server");

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

describe("the createWatch endpoint's authorization", () => {
  function post(body: unknown) {
    return createAction({
      request: new Request("https://example.com/api/v1/dashboard-agent/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: {},
      context: {},
    });
  }

  const validBody = (chatId: string) => ({ spec: RUN_START, chatId });

  postgresTest("401s without a delegated token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const response = await post(validBody("chat_1"));
    expect(response.status).toBe(401);
  });

  postgresTest("403s for any other client's token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "adapter");
    ctx.actor = { userId: seeded.user.id, client: "cli", environmentId: seeded.environment.id };

    const response = await post(validBody("chat_1"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden_client" });
  });

  postgresTest(
    "refuses a chat the authenticated user doesn't own, writing nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const owner = await seed(prisma, "owner");
      const stranger = await seed(prisma, "stranger");
      await createChat(ctx.agentDb, {
        id: "chat_victim",
        organizationId: owner.organization.id,
        userId: owner.user.id,
      });

      ctx.actor = {
        userId: stranger.user.id,
        client: "dashboard-agent",
        environmentId: stranger.environment.id,
      };

      const response = await post(validBody("chat_victim"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "chat_not_found" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_victim" })).toHaveLength(
        0
      );
    }
  );

  postgresTest(
    "refuses a token with no environment scope",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "noscope");
      await seedChat(seeded, "chat_1");
      ctx.actor = { userId: seeded.user.id, client: "dashboard-agent" };

      const response = await post(validBody("chat_1"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "refuses a body naming a different environment than the token's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "mismatch");
      const other = await seed(prisma, "othermismatch");
      await seedChat(seeded, "chat_1");
      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      const response = await post({
        ...validBody("chat_1"),
        environmentId: other.environment.id,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "environment_mismatch" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "binds to the token's environment, not the chat's stored context",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "binding");
      const otherProject = await prisma.project.create({
        data: {
          name: `${seeded.project.slug}_b`,
          slug: `${seeded.project.slug}_b`,
          organizationId: seeded.organization.id,
          externalRef: `proj_${seeded.project.slug}_b`,
        },
      });
      const otherEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: otherProject.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_prod_${otherProject.slug}`,
          pkApiKey: `pk_prod_${otherProject.slug}`,
          shortcode: `b${otherProject.slug.slice(0, 6)}`,
        },
      });

      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        metadata: {
          context: {
            environmentId: seeded.environment.id,
            projectRef: seeded.project.externalRef,
          },
        },
      });
      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: otherEnvironment.id,
      };

      const response = await post({
        ...validBody("chat_1"),
        projectRef: seeded.project.externalRef,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "environment_mismatch" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "refuses an environment in another org than the chat's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "crossorg");
      const other = await seed(prisma, "otherorg");
      await prisma.orgMember.create({
        data: {
          organizationId: other.organization.id,
          userId: seeded.user.id,
          role: "ADMIN",
        },
      });
      await seedChat(seeded, "chat_1");

      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: other.environment.id,
      };

      const response = await post(validBody("chat_1"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );
});

describe("the check endpoint", () => {
  function request(token: string, body: unknown = {}) {
    return new Request("https://example.com/api/v1/dashboard-agent/watches/x/check", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function activeWatch(seeded: Seeded, spec?: WatchSpec) {
    const result = await create({ seeded, spec });
    if (!result.ok) throw new Error(`watch not created: ${result.code}`);
    return result;
  }

  function tokenFor(watchId: string, expiresAt: Date) {
    return signDashboardAgentWatchToken(SESSION_SECRET, { watchId, expiresAt });
  }

  postgresTest("401s on a bad token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);

    const response = await checkAction({
      request: request("tr_daw_nonsense"),
      params: { watchId: watch.watchId },
      context: {},
    });
    expect(response.status).toBe(401);
  });

  postgresTest("403s when the token names another watch", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);
    const token = await tokenFor("watch_someone_else", watch.expiresAt);

    const response = await checkAction({
      request: request(token),
      params: { watchId: watch.watchId },
      context: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "watch_mismatch" });
  });

  postgresTest("answers a check and records what it saw", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);
    const token = await tokenFor(watch.watchId, watch.expiresAt);

    const response = await checkAction({
      request: request(token),
      params: { watchId: watch.watchId },
      context: {},
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBe("terminal_unsatisfied");

    // Arming the chain goes through the stubbed client, never a real trigger.
    expect(ctx.triggered).toContain("dashboard-agent-watch-batch");

    const row = await getWatch(ctx.agentDb, { id: watch.watchId });
    expect(row?.lastCheckedAt).not.toBeNull();
    expect(row?.tickCount).toBe(0);
    expect(row?.status).toBe("active");
  });

  postgresTest(
    "refuses an ordinary check after expiry but allows the final one in grace",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);
      const watch = await activeWatch(seeded);

      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 minute' where id = $1`,
        watch.watchId
      );

      const token = await tokenFor(watch.watchId, watch.expiresAt);

      const refused = await checkAction({
        request: request(token, {}),
        params: { watchId: watch.watchId },
        context: {},
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "expired" });

      const allowed = await checkAction({
        request: request(token, { final: true }),
        params: { watchId: watch.watchId },
        context: {},
      });
      expect(allowed.status).toBe(200);
    }
  );

  postgresTest(
    "cancels the watch on revoked access, without reading environment data",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);
      const watch = await activeWatch(seeded);
      const token = await tokenFor(watch.watchId, watch.expiresAt);

      await prisma.orgMember.deleteMany({ where: { userId: seeded.user.id } });

      const response = await checkAction({
        request: request(token),
        params: { watchId: watch.watchId },
        context: {},
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "access_revoked" });

      const row = await getWatch(ctx.agentDb, { id: watch.watchId });
      expect(row).toMatchObject({
        status: "cancelled",
        cancelReason: "access_revoked",
        deliveryStatus: "not_required",
      });
      expect(row?.tickCount).toBe(0);
      expect(row?.lastResult).toBeNull();
    }
  );

  postgresTest(
    "a check that couldn't read anything leaves the row's last look and facts alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);

      // The queue exists, so the check gets past the target read and fails on the depth
      // read: there is no live queue or analytics store behind this environment.
      const queue = "task/stalling";
      await prisma.taskQueue.create({
        data: {
          runtimeEnvironmentId: seeded.environment.id,
          projectId: seeded.project.id,
          name: queue,
          friendlyId: `queue_${Math.random().toString(36).slice(2, 10)}`,
          orderableName: queue,
        },
      });

      const watch = await activeWatch(seeded, {
        kind: "queue_stalled",
        queue,
        ticks: 3,
        checkEveryMinutes: 5,
        maxHours: 6,
        note: "tell me if the queue stops moving",
      });

      // Two no-progress checks already behind it, last looked at an hour ago.
      const checkedAt = new Date(Date.now() - 60 * 60 * 1000);
      await recordWatchCheck(ctx.agentDb, {
        id: watch.watchId,
        lastCheckedAt: checkedAt,
        lastResult: {
          result: "pending",
          facts: { queue, depth: 412, notDecreasingStreak: 2, ticks: 3 },
        },
      });

      const token = await tokenFor(watch.watchId, watch.expiresAt);
      const response = await checkAction({
        request: request(token),
        params: { watchId: watch.watchId },
        context: {},
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: "unavailable" });

      const row = await getWatch(ctx.agentDb, { id: watch.watchId });
      // Nothing was checked, so the watch is still due at the next tick.
      expect(row?.lastCheckedAt?.getTime()).toBe(checkedAt.getTime());
      // And the streak the earlier ticks built is still there to be continued.
      expect(previousCheckFacts(row?.lastResult)).toMatchObject({
        depth: 412,
        notDecreasingStreak: 2,
      });
    },
    120_000
  );

  postgresTest("403s once the watch is terminal", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);
    const token = await tokenFor(watch.watchId, watch.expiresAt);

    await prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches set status = 'cancelled' where id = $1`,
      watch.watchId
    );

    const response = await checkAction({
      request: request(token),
      params: { watchId: watch.watchId },
      context: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cancelled" });
  });
});

describe("the agent's alert boundary", () => {
  /** A second, plain member of the same organization. */
  async function seedMember(prisma: PrismaClient, seeded: Seeded) {
    const member = await prisma.user.create({
      data: {
        email: `member_${Math.random().toString(36).slice(2, 10)}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    await prisma.orgMember.create({
      data: { organizationId: seeded.organization.id, userId: member.id, role: "MEMBER" },
    });
    return member;
  }

  async function seedOutsider(prisma: PrismaClient) {
    return prisma.user.create({
      data: {
        email: `outsider_${Math.random().toString(36).slice(2, 10)}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
  }

  async function seedWatchChannel(prisma: PrismaClient, seeded: Seeded, email: string) {
    return prisma.projectAlertChannel.create({
      data: {
        friendlyId: `alert_${Math.random().toString(36).slice(2, 10)}`,
        name: `Watch alerts for ${email}`,
        projectId: seeded.project.id,
        alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE as never],
        environmentTypes: ["PRODUCTION"],
        type: "EMAIL",
        properties: { email },
        deduplicationKey: `dashboard-agent-watch:${email}`,
      },
    });
  }

  function listRequest(chatId: string) {
    return {
      request: new Request(
        `https://app.trigger.dev/api/v1/dashboard-agent/alerts?chatId=${chatId}`,
        { headers: { Authorization: "Bearer tr_uat_test" } }
      ),
      params: {},
      context: {} as never,
    } as never;
  }

  function createRequest(body: Record<string, unknown>) {
    return {
      request: new Request("https://app.trigger.dev/api/v1/dashboard-agent/alerts", {
        method: "POST",
        headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: {},
      context: {} as never,
    } as never;
  }

  function deleteRequest(channelId: string, body: Record<string, unknown>) {
    return {
      request: new Request(`https://app.trigger.dev/api/v1/dashboard-agent/alerts/${channelId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: { channelId },
      context: {} as never,
    } as never;
  }

  postgresTest(
    "the dashboard lets any organization member manage a project's alerts",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-policy");
      const member = await seedMember(prisma, seeded);
      const outsider = await seedOutsider(prisma);

      // The whole of the Alerts page's authorization, for list, create and delete alike.
      expect(
        await findProjectBySlug(seeded.organization.slug, seeded.project.slug, member.id)
      ).not.toBeNull();
      expect(
        await findProjectBySlug(seeded.organization.slug, seeded.project.slug, outsider.id)
      ).toBeNull();
    }
  );

  postgresTest(
    "a plain member reads and writes watch alerts through the agent, an outsider reads nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-member");
      const member = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_member",
        organizationId: seeded.organization.id,
        userId: member.id,
      });
      await seedWatchChannel(prisma, seeded, member.email);

      ctx.actor = {
        userId: member.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const listed = (await alertsLoader(listRequest("chat_member"))) as Response;
      expect(listed.status).toBe(200);
      // The same channel the Alerts page would show this member.
      expect((await listed.json()).alerts).toHaveLength(1);

      // An outsider has no chat here and no membership, so nothing resolves.
      ctx.actor = {
        userId: (await seedOutsider(prisma)).id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const refused = (await alertsLoader(listRequest("chat_member"))) as Response;
      expect(refused.status).toBe(404);
    }
  );

  postgresTest(
    "the agent only ever subscribes the caller's own address",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-create");
      const member = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_member",
        organizationId: seeded.organization.id,
        userId: member.id,
      });

      ctx.actor = {
        userId: member.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      const own = (await alertsAction(
        createRequest({ chatId: "chat_member", channel: "email" })
      )) as Response;
      expect(own.status).toBe(200);
      expect((await own.json()).target).toBe(member.email);

      // The Alerts page would let this member add anyone; the agent may not.
      const other = (await alertsAction(
        createRequest({
          chatId: "chat_member",
          channel: "email",
          email: "someone-else@example.com",
        })
      )) as Response;
      expect(other.status).toBe(400);
      expect(await other.json()).toMatchObject({ code: "email_not_allowed" });

      expect(
        await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
      ).toBe(1);
    }
  );

  postgresTest(
    "the agent's delete only takes the watch type off a watch channel",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-delete");
      const member = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_member",
        organizationId: seeded.organization.id,
        userId: member.id,
      });
      const watchChannel = await seedWatchChannel(prisma, seeded, member.email);

      // A channel the agent never created and has no business touching.
      const runAlerts = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `alert_${Math.random().toString(36).slice(2, 10)}`,
          name: "Run failures",
          projectId: seeded.project.id,
          alertTypes: ["TASK_RUN"],
          environmentTypes: ["PRODUCTION"],
          type: "EMAIL",
          properties: { email: member.email },
        },
      });

      ctx.actor = {
        userId: member.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      const removed = (await alertChannelAction(
        deleteRequest(watchChannel.id, { chatId: "chat_member" })
      )) as Response;
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ ok: true, disabledChannel: true });

      // The Alerts page would let a member delete this outright; the agent gets a 404.
      const untouched = (await alertChannelAction(
        deleteRequest(runAlerts.id, { chatId: "chat_member" })
      )) as Response;
      expect(untouched.status).toBe(404);
      expect(
        await prisma.projectAlertChannel.findFirst({ where: { id: runAlerts.id } })
      ).toMatchObject({ enabled: true, alertTypes: ["TASK_RUN"] });

      // An outsider can't reach the channel at all.
      ctx.actor = {
        userId: (await seedOutsider(prisma)).id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const refused = (await alertChannelAction(
        deleteRequest(watchChannel.id, { chatId: "chat_member" })
      )) as Response;
      expect(refused.status).toBe(404);
    }
  );
});
