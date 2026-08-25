/**
 * `emailAlerts` in the create-watch response is a statement about the caller's own
 * subscription. A project is shared by every member, so another member's channel must
 * never be reported as the caller's.
 */

import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type * as SdkModule from "@trigger.dev/sdk";
import { afterEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps, WatchRunRow } from "~/services/dashboardAgentWatchChecks";
import type * as WatchChecksModule from "~/services/dashboardAgentWatchChecks.server";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  actor: undefined as undefined | { userId: string; client?: string; environmentId?: string },
}));

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
  canAccessDashboardAgent: async () => true,
}));

// The watch target's readers are the IO seam. The alert channels this file is about stay
// real rows in the container.
vi.mock("~/services/dashboardAgentWatchChecks.server", async (importOriginal) => ({
  ...(await importOriginal<typeof WatchChecksModule>()),
  watchCreationCheckDeps: (): WatchCheckDeps => fakeCheckDeps(),
}));

// The first tick is scheduled by triggering a task over the network.
vi.mock("@trigger.dev/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkModule>()),
  TriggerClient: class {
    tasks = { trigger: async () => ({ id: "run_tick" }) };
  },
}));

process.env.SESSION_SECRET = "test-session-secret-for-watch-alert-owner-scope";
// Without a secret key the create path refuses as "not configured".
process.env.DASHBOARD_AGENT_SECRET_KEY = "tr_pat_test_dashboard_agent";
// The subscribe path refuses outright without an email transport configured.
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";

const { action: watchesAction } = await import("~/routes/api.v1.dashboard-agent.watches");
const { subscribeUserToWatchAlerts, DASHBOARD_AGENT_WATCH_ALERT_TYPE } =
  await import("~/services/dashboardAgentWatchAlerts.server");

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  ctx.actor = undefined;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

function runRow(): WatchRunRow {
  return {
    friendlyId: "run_1",
    status: "PENDING",
    queue: "task/my-task",
    createdAt: new Date(),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    delayUntil: null,
  };
}

/** Keeps the condition pending with a live target, so a create always makes a watch. */
function fakeCheckDeps(): WatchCheckDeps {
  return {
    readRun: async () => runRow(),
    queueExists: async () => true,
    readQueueDepth: async () => ({ depth: 7, source: "live_queue", current: true }),
    readQueueOldestAge: async () => ({ ageMs: 30_000, source: "live_queue", current: true }),
    readErrorRecurrence: async () => null,
    readHealth: async () => ({ trustworthy: true, severity: "warn" }),
  };
}

/** One organization with a production environment, and two members of it. */
async function seedProject(prisma: PrismaClient) {
  const slug = `alertscope_${suffix()}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `pr${suffix()}`,
    },
  });
  return { organization, project, environment };
}

type Seeded = Awaited<ReturnType<typeof seedProject>>;

async function seedMember(prisma: PrismaClient, seeded: Seeded, name: string) {
  const user = await prisma.user.create({
    data: { email: `${name}_${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.orgMember.create({
    data: { organizationId: seeded.organization.id, userId: user.id, role: "MEMBER" },
  });
  return user;
}

function subscribeEnvironment(seeded: Seeded) {
  return {
    type: seeded.environment.type as string,
    organizationId: seeded.organization.id,
    organization: { slug: seeded.organization.slug },
    project: { id: seeded.project.id, externalRef: seeded.project.externalRef },
  };
}

function spec(runId: string): WatchSpec {
  return { kind: "run_start", runId, checkEveryMinutes: 1, maxHours: 2, note: "tell me" };
}

/**
 * Creates a watch through the real endpoint as `user`, and answers with the response body
 * the caller is told — the only place the subscription claim is visible.
 */
async function createWatchAs(
  seeded: Seeded,
  user: { id: string },
  chatId: string
): Promise<Record<string, unknown>> {
  await createChat(ctx.agentDb, {
    id: chatId,
    organizationId: seeded.organization.id,
    userId: user.id,
  });

  ctx.actor = {
    userId: user.id,
    client: "dashboard-agent",
    environmentId: seeded.environment.id,
  };

  const response = (await watchesAction({
    request: new Request("https://app.trigger.dev/api/v1/dashboard-agent/watches", {
      method: "POST",
      headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
      body: JSON.stringify({ spec: spec(`run_${chatId}`), chatId }),
    }),
    params: {},
    context: {} as never,
  } as never)) as Response;

  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ watching: true });
  return body;
}

describe("the create-watch response's email alert state", () => {
  postgresTest(
    "reports only the caller's own subscription, never another member's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProject(prisma);
      const alice = await seedMember(prisma, seeded, "alice");
      const bob = await seedMember(prisma, seeded, "bob");

      const subscribed = await subscribeUserToWatchAlerts({
        userId: alice.id,
        environment: subscribeEnvironment(seeded),
      });
      expect(subscribed).toMatchObject({ ok: true, email: alice.email });

      // One channel exists in the project, and it mails Alice. Bob is not on it.
      expect(
        await prisma.projectAlertChannel.count({
          where: {
            projectId: seeded.project.id,
            alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
          },
        })
      ).toBe(1);

      const bobBefore = await createWatchAs(seeded, bob, "chat_bob_before");
      expect(bobBefore.emailAlerts).toBe("none");

      const bobSubscribed = await subscribeUserToWatchAlerts({
        userId: bob.id,
        environment: subscribeEnvironment(seeded),
      });
      expect(bobSubscribed).toMatchObject({ ok: true, email: bob.email });

      // His own channel, so now the claim is true.
      const bobAfter = await createWatchAs(seeded, bob, "chat_bob_after");
      expect(bobAfter.emailAlerts).toBe("subscribed");

      // Bob subscribing did not take over or restate Alice's own channel.
      const aliceState = await createWatchAs(seeded, alice, "chat_alice");
      expect(aliceState.emailAlerts).toBe("subscribed");

      const channels = await prisma.projectAlertChannel.findMany({
        where: { projectId: seeded.project.id },
        select: { properties: true },
      });
      expect(channels).toHaveLength(2);
      expect(
        channels.map((channel) => (channel.properties as { email: string }).email).sort()
      ).toEqual([alice.email, bob.email].sort());
    },
    30_000
  );
});
