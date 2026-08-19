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
  DashboardAgentWatchesTestHarness,
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

const { createDashboardAgentWatch } = await import("~/services/dashboardAgentWatches.server");
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
const create = harness.create.bind(harness);

beforeEach(() => harness.reset());
afterEach(() => harness.close());

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
