import {
  armWatchBatch,
  cancelWatch,
  claimWatchBatchTick,
  claimWatchDelivery,
  createChat,
  getWatch,
  listActiveWatchesForBatch,
  listWatchBatchGroupsToArm,
  markWatchDelivered,
  recordWatchCheck,
  stopWatchBatch,
  transitionWatchCondition,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type DashboardAgentDb,
} from "@internal/dashboard-agent-db";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  DashboardAgentWatchesTestHarness,
  HEALTH,
  RUN_START,
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

const SESSION_SECRET = "test-session-secret-for-watch-tokens";
process.env.SESSION_SECRET = SESSION_SECRET;

const { armDashboardAgentWatchBatch, createDashboardAgentWatch, watchBatchStaleMs } =
  await import("~/services/dashboardAgentWatches.server");
const { rearmDashboardAgentWatchBatches } =
  await import("~/services/dashboardAgentWatchSweep.server");
const { runWatchBatchCheck } = await import("~/services/dashboardAgentWatchBatch.server");
const { signDashboardAgentWatchBatchToken, signDashboardAgentWatchToken } =
  await import("~/services/dashboardAgentWatchToken.server");
const { action: batchCheckAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.batch-check");

const harness = new DashboardAgentWatchesTestHarness(ctx, createDashboardAgentWatch);
const boot = harness.boot.bind(harness);
const seed = harness.seed.bind(harness);
const authenticated = harness.authenticated.bind(harness);
const seedChat = harness.seedChat.bind(harness);
const fakeCheckDeps = harness.fakeCheckDeps.bind(harness);
const create = harness.create.bind(harness);

beforeEach(() => harness.reset());
afterEach(() => harness.close());

describe("the batch chain registry", () => {
  postgresTest("arms one chain per group, and only one", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "batcharm");
    const now = new Date();

    const scheduled: Array<{ epoch: number; tick: number }> = [];
    const arm = () =>
      armDashboardAgentWatchBatch({
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        now,
        deps: {
          schedule: async (params) =>
            void scheduled.push({ epoch: params.epoch, tick: params.tick }),
        },
      });

    expect(await arm()).toEqual({ running: true });
    expect(scheduled).toEqual([{ epoch: 1, tick: 1 }]);

    expect(await arm()).toEqual({ running: true });
    expect(await arm()).toEqual({ running: true });
    expect(scheduled).toHaveLength(1);
  });

  postgresTest(
    "a chain whose run died is re-armed on a fresh epoch, and the zombie claims nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchdead");
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5 };

      const scheduled: Array<{ epoch: number; tick: number }> = [];
      const arm = (now: Date) =>
        armDashboardAgentWatchBatch({
          ...group,
          now,
          deps: {
            schedule: async (params) =>
              void scheduled.push({ epoch: params.epoch, tick: params.tick }),
          },
        });

      const armedAt = new Date();
      await arm(armedAt);
      expect(
        await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 1, generation: 1 })
      ).toMatchObject({ epoch: 1, generation: 1 });

      await arm(new Date(armedAt.getTime() + 60_000));
      expect(scheduled).toHaveLength(1);

      await arm(new Date(armedAt.getTime() + watchBatchStaleMs(5) + 60_000));
      expect(scheduled).toEqual([
        { epoch: 1, tick: 1 },
        { epoch: 2, tick: 1 },
      ]);

      expect(await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 1, generation: 2 })).toBe(
        null
      );
      expect(
        await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 2, generation: 1 })
      ).toMatchObject({ epoch: 2, generation: 1 });
    }
  );

  postgresTest(
    "a chain that couldn't be triggered is not left marked as running",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchfail");
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5 };

      expect(
        await armDashboardAgentWatchBatch({
          ...group,
          deps: {
            schedule: async () => {
              throw new Error("the trigger failed");
            },
          },
        })
      ).toEqual({ running: false });

      const scheduled: number[] = [];
      expect(
        await armDashboardAgentWatchBatch({
          ...group,
          deps: { schedule: async (params) => void scheduled.push(params.epoch) },
        })
      ).toEqual({ running: true });
      expect(scheduled).toEqual([2]);
    }
  );

  postgresTest(
    "the re-arm backstop finds groups with active watches and no chain",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchrearm");
      await seedChat(seeded);
      const created = await create({
        seeded,
        spec: HEALTH,
        checkDeps: { readHealth: async () => null },
      });
      expect(created.ok).toBe(true);

      const groups = await listWatchBatchGroupsToArm(ctx.agentDb);
      expect(groups).toEqual([{ environmentId: seeded.environment.id, cadenceMinutes: 5 }]);

      const armed: Array<{ environmentId: string; cadenceMinutes: number }> = [];
      expect(
        await rearmDashboardAgentWatchBatches({
          configured: () => true,
          arm: async (params) => {
            armed.push({
              environmentId: params.environmentId,
              cadenceMinutes: params.cadenceMinutes,
            });
            return { running: true };
          },
        })
      ).toEqual({ stale: 1, armed: 1, failed: 0 });
      expect(armed).toEqual([{ environmentId: seeded.environment.id, cadenceMinutes: 5 }]);

      // The staleness window is the group's own cadence: a five-minute group goes stale 17 minutes later.
      await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        staleBefore: new Date(),
      });
      expect(await listWatchBatchGroupsToArm(ctx.agentDb)).toEqual([]);
      expect(
        await listWatchBatchGroupsToArm(ctx.agentDb, {
          now: new Date(Date.now() + watchBatchStaleMs(5) + 60_000),
        })
      ).toEqual([{ environmentId: seeded.environment.id, cadenceMinutes: 5 }]);
    }
  );

  postgresTest(
    "groups are per environment and per cadence, never mixed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchgroup");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");
      expect((await create({ seeded, chatId: "chat_1", spec: HEALTH })).ok).toBe(true);
      expect((await create({ seeded, chatId: "chat_2", spec: RUN_START })).ok).toBe(true);

      const five = await listActiveWatchesForBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
      });
      const one = await listActiveWatchesForBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 1,
      });

      expect(five.map((watch) => watch.chatId)).toEqual(["chat_1"]);
      expect(one.map((watch) => watch.chatId)).toEqual(["chat_2"]);
      expect(
        (await listWatchBatchGroupsToArm(ctx.agentDb)).sort(
          (a, b) => a.cadenceMinutes - b.cadenceMinutes
        )
      ).toEqual([
        { environmentId: seeded.environment.id, cadenceMinutes: 1 },
        { environmentId: seeded.environment.id, cadenceMinutes: 5 },
      ]);
    }
  );
});

describe("the batch check", () => {
  async function healthGroup(seeded: Seeded, count = 3) {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const chatId = `chat_${index + 1}`;
      await seedChat(seeded, chatId);
      const created = await create({
        seeded,
        chatId,
        spec: HEALTH,
        // `warn` keeps them all pending, so the group stays whole for the assertions below.
        checkDeps: { readHealth: async () => ({ trustworthy: true, severity: "warn" }) },
      });
      if (!created.ok || !created.watching) throw new Error("the watch wasn't created");
      ids.push(created.watchId);
    }
    return ids;
  }

  async function otherUsersWatch(seeded: Seeded, prisma: PrismaClient) {
    const user = await prisma.user.create({
      data: {
        email: `other_${seeded.organization.slug}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    await prisma.orgMember.create({
      data: { organizationId: seeded.organization.id, userId: user.id, role: "MEMBER" },
    });
    await createChat(ctx.agentDb, {
      id: "chat_other",
      organizationId: seeded.organization.id,
      userId: user.id,
    });
    const created = await createDashboardAgentWatch({
      environment: authenticated(seeded),
      userId: user.id,
      chatId: "chat_other",
      spec: HEALTH,
      deps: {
        configured: () => true,
        checkDeps: () =>
          fakeCheckDeps({ readHealth: async () => ({ trustworthy: true, severity: "warn" }) }),
        scheduleTick: async () => {},
      },
    });
    if (!created.ok || !created.watching) throw new Error("the watch wasn't created");
    return { userId: user.id, watchId: created.watchId };
  }

  async function armChain(seeded: Seeded, cadenceMinutes = 5) {
    const row = await armWatchBatch(ctx.agentDb, {
      environmentId: seeded.environment.id,
      cadenceMinutes,
      staleBefore: new Date(),
    });
    if (!row) throw new Error("the chain wasn't armed");
    return row;
  }

  postgresTest(
    "authorizes once and loads the shared report once for the whole group",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchcheck");
      const ids = await healthGroup(seeded);
      const chain = await armChain(seeded);

      let healthReads = 0;
      let authorizations = 0;

      const response = await runWatchBatchCheck(
        {
          environmentId: seeded.environment.id,
          cadenceMinutes: 5,
          epoch: chain.epoch,
          tick: 1,
        },
        {
          authorize: async () => {
            authorizations++;
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () =>
            fakeCheckDeps({
              readHealth: async () => {
                healthReads++;
                return { trustworthy: true, severity: "warn" };
              },
            }),
        }
      );

      expect(authorizations).toBe(1);
      expect(healthReads).toBe(1);

      expect(response.watches?.map((entry) => entry.watchId).sort()).toEqual([...ids].sort());
      expect(response.watches?.every((entry) => entry.result === "pending")).toBe(true);
      expect(response.watches?.every((entry) => entry.tick === 1)).toBe(true);
      expect(response.watches?.every((entry) => entry.token.length > 0)).toBe(true);
      expect(response.continues).toBe(true);
      expect(response.stale).toBeUndefined();

      for (const id of ids) {
        expect((await getWatch(ctx.agentDb, { id }))?.lastResult).toMatchObject({
          result: "pending",
          final: false,
        });
      }
    }
  );

  postgresTest(
    "authorizes each distinct user, so sharing readers never shares access",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchusers");
      await healthGroup(seeded, 2);
      const other = await otherUsersWatch(seeded, prisma);

      const chain = await armChain(seeded);
      const authorized: string[] = [];

      await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          authorize: async (watch) => {
            authorized.push(watch.userId);
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () => fakeCheckDeps(),
        }
      );

      expect(authorized.sort()).toEqual([other.userId, seeded.user.id].sort());
    }
  );

  postgresTest(
    "cancels a watch whose user lost access, and still answers for its neighbours",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchrevoked");
      const ids = await healthGroup(seeded, 2);
      const chain = await armChain(seeded);

      const response = await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          authorize: async () => ({ ok: false, reason: "access_revoked" }),
          checkDeps: () => fakeCheckDeps(),
        }
      );

      expect(response.watches?.every((entry) => entry.code === "access_revoked")).toBe(true);
      for (const id of ids) {
        expect(await getWatch(ctx.agentDb, { id })).toMatchObject({
          status: "cancelled",
          cancelReason: "access_revoked",
          deliveryStatus: "not_required",
        });
      }
    }
  );

  postgresTest(
    "checks what is due, skips what isn't, and never skips a window boundary",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchdue");
      const [fresh, overdue, boundary] = await healthGroup(seeded, 3);
      const chain = await armChain(seeded);
      const now = new Date();

      await recordWatchCheck(ctx.agentDb, { id: fresh!, lastCheckedAt: now });
      await recordWatchCheck(ctx.agentDb, {
        id: overdue!,
        lastCheckedAt: new Date(now.getTime() - 10 * 60_000),
      });
      // `boundary`'s window closes before the next tick, so its final evaluation must still happen.
      await recordWatchCheck(ctx.agentDb, { id: boundary!, lastCheckedAt: now });
      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() + interval '1 minute' where id = $1`,
        boundary
      );

      const response = await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          now: () => now,
          authorize: async () => ({ ok: true, environment: authenticated(seeded) }),
          checkDeps: () => fakeCheckDeps(),
        }
      );

      expect(response.watches?.map((entry) => entry.watchId).sort()).toEqual(
        [boundary!, overdue!].sort()
      );
      expect(response.continues).toBe(true);
    }
  );

  postgresTest(
    "a stale tick claims nothing and checks nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchstale");
      const ids = await healthGroup(seeded, 1);
      const chain = await armChain(seeded);

      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch };
      expect((await runWatchBatchCheck({ ...group, tick: 1 })).stale).toBeUndefined();
      expect((await runWatchBatchCheck({ ...group, tick: 2 })).stale).toBeUndefined();

      const late = await runWatchBatchCheck({ ...group, tick: 1 });
      expect(late).toEqual({ stale: true });

      expect(await runWatchBatchCheck({ ...group, epoch: chain.epoch - 1, tick: 1 })).toEqual({
        stale: true,
      });
      expect((await getWatch(ctx.agentDb, { id: ids[0]! }))?.status).toBe("active");
    }
  );

  postgresTest(
    "stops the chain when the group's last watch is gone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchempty");
      const ids = await healthGroup(seeded, 1);
      const chain = await armChain(seeded);
      await cancelWatch(ctx.agentDb, { id: ids[0]!, reason: "user" });

      const response = await runWatchBatchCheck({
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        epoch: chain.epoch,
        tick: 1,
      });

      expect(response).toMatchObject({ watches: [], continues: false });

      const rearmed = await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        // Deliberately in the past: only a stopped chain can be re-armed this way.
        staleBefore: new Date(Date.now() - 60 * 60_000),
      });
      expect(rearmed).toMatchObject({ epoch: chain.epoch + 1, status: "running" });
    }
  );

  postgresTest(
    "hands the group's owed wakes back for redelivery",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchowed");
      const ids = await healthGroup(seeded, 2);
      const chain = await armChain(seeded);

      await transitionWatchCondition(ctx.agentDb, {
        id: ids[0]!,
        resolution: "condition_met",
        lastResult: { verified: true },
      });

      const response = await runWatchBatchCheck({
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        epoch: chain.epoch,
        tick: 1,
      });

      const owed = response.watches?.filter((entry) => entry.deliverOnly === true) ?? [];
      expect(owed.map((entry) => entry.watchId)).toEqual([ids[0]!]);
      expect(owed[0]?.tick).toBe(0);
      expect(
        response.watches?.filter((entry) => !entry.deliverOnly).map((entry) => entry.watchId)
      ).toEqual([ids[1]!]);
    }
  );

  postgresTest(
    "keeps the chain alive while a wake is still owed, even with nothing left to watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchowedlast");
      const ids = await healthGroup(seeded, 1);
      const chain = await armChain(seeded);
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5 };

      await transitionWatchCondition(ctx.agentDb, {
        id: ids[0]!,
        resolution: "condition_met",
        lastResult: { verified: true },
      });

      const first = await runWatchBatchCheck({ ...group, epoch: chain.epoch, tick: 1 });
      expect(first.continues).toBe(true);
      expect(first.watches?.map((entry) => entry.deliverOnly)).toEqual([true]);

      const claim = await claimWatchDelivery(ctx.agentDb, {
        id: ids[0]!,
        staleBefore: new Date(Date.now() - WATCH_DELIVERY_CLAIM_STALE_MS),
      });
      await markWatchDelivered(ctx.agentDb, { id: ids[0]!, claimId: claim!.claimId });

      const second = await runWatchBatchCheck({ ...group, epoch: chain.epoch, tick: 2 });
      expect(second).toMatchObject({ watches: [], continues: false });
      expect(await stopWatchBatch(ctx.agentDb, { ...group, epoch: chain.epoch })).toBe(null);
    }
  );

  postgresTest(
    "one watch that throws mid-evaluation costs only that watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchthrow");
      const mine = await healthGroup(seeded, 2);
      const theirs = await otherUsersWatch(seeded, prisma);
      const chain = await armChain(seeded);

      const response = await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          authorize: async (watch) => {
            if (watch.userId === theirs.userId) throw new Error("the authorization query failed");
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () => fakeCheckDeps(),
          concurrency: 1,
        }
      );

      const byId = new Map(response.watches?.map((entry) => [entry.watchId, entry]));
      expect(byId.get(theirs.watchId)).toMatchObject({ result: "unavailable" });
      expect((await getWatch(ctx.agentDb, { id: theirs.watchId }))?.status).toBe("active");
      for (const id of mine) {
        expect(byId.get(id)).toMatchObject({ result: "pending" });
      }
    }
  );
});

describe("the batch check endpoint's authorization", () => {
  function batchRequest(body: unknown, token?: string) {
    return new Request("https://app.trigger.dev/api/v1/dashboard-agent/watches/batch-check", {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  const batchToken = (environmentId: string, cadenceMinutes: number) =>
    signDashboardAgentWatchBatchToken(SESSION_SECRET, {
      environmentId,
      cadenceMinutes,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

  postgresTest("refuses a missing or bad token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const body = { environmentId: "env_1", cadenceMinutes: 5, epoch: 1, tick: 1 };

    expect(
      (await batchCheckAction({ request: batchRequest(body), params: {}, context: {} })).status
    ).toBe(401);
    const watchToken = await signDashboardAgentWatchToken(SESSION_SECRET, {
      watchId: "watch_1",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    expect(
      (await batchCheckAction({ request: batchRequest(body, watchToken), params: {}, context: {} }))
        .status
    ).toBe(401);
  });

  postgresTest(
    "refuses a token minted for another group",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const token = await batchToken("env_1", 5);

      const wrongCadence = await batchCheckAction({
        request: batchRequest(
          { environmentId: "env_1", cadenceMinutes: 15, epoch: 1, tick: 1 },
          token
        ),
        params: {},
        context: {},
      });
      expect(wrongCadence.status).toBe(403);
      expect(await wrongCadence.json()).toMatchObject({ code: "group_mismatch" });

      const wrongEnvironment = await batchCheckAction({
        request: batchRequest(
          { environmentId: "env_2", cadenceMinutes: 5, epoch: 1, tick: 1 },
          token
        ),
        params: {},
        context: {},
      });
      expect(wrongEnvironment.status).toBe(403);
    }
  );

  postgresTest(
    "answers a group it does own, through the real registry",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchroute");
      const chain = await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        staleBefore: new Date(),
      });
      const token = await batchToken(seeded.environment.id, 5);

      const response = await batchCheckAction({
        request: batchRequest(
          {
            environmentId: seeded.environment.id,
            cadenceMinutes: 5,
            epoch: chain!.epoch,
            tick: 1,
          },
          token
        ),
        params: {},
        context: {},
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ watches: [], continues: false });
      expect(
        await stopWatchBatch(ctx.agentDb, {
          environmentId: seeded.environment.id,
          cadenceMinutes: 5,
          epoch: chain!.epoch,
        })
      ).toBe(null);
    }
  );
});
