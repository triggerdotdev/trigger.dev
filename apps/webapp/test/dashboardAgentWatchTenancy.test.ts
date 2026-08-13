/**
 * The tenancy floor of the watch submission ledger, plus the two boundaries that hang off
 * it: the fire callback's alert (once per terminal outcome) and the alert unsubscribe
 * (the caller's own channel only).
 */

import {
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getWatchSubmission,
  transitionWatchCondition,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchDraft, WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps, WatchRunRow } from "~/services/dashboardAgentWatchChecks";

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

const SESSION_SECRET = "test-session-secret-for-watch-tenancy";
process.env.SESSION_SECRET = SESSION_SECRET;
// The subscribe path refuses outright without an email transport configured.
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";

const { submitDashboardAgentWatch } = await import("~/services/dashboardAgentWatches.server");
const { action: firedAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.$watchId.fired");
const { action: alertChannelAction } =
  await import("~/routes/api.v1.dashboard-agent.alerts.$channelId");
const { signDashboardAgentWatchToken } = await import("~/services/dashboardAgentWatchToken.server");
const { DASHBOARD_AGENT_WATCH_ALERT_TYPE, watchAlertDeduplicationKey } =
  await import("~/services/dashboardAgentWatchAlerts.server");
const { alertsWorker } = await import("~/v3/alertsWorker.server");

const enqueue = alertsWorker.enqueue as unknown as ReturnType<typeof vi.fn>;

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  ctx.actor = undefined;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

beforeEach(() => {
  enqueue.mockClear();
});

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** One organization, one project, one production environment, and a user who is a member. */
async function seedOrg(prisma: PrismaClient, slugBase: string, user?: { id: string }) {
  const slug = `${slugBase}_${suffix()}`;
  const owner =
    user ??
    (await prisma.user.create({
      data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
    }));
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: owner.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await environmentFor(prisma, organization.id, project.id, slug, "prod");
  return { user: owner, organization, project, environment };
}

async function environmentFor(
  prisma: PrismaClient,
  organizationId: string,
  projectId: string,
  slugBase: string,
  slug: "prod" | "staging"
) {
  return prisma.runtimeEnvironment.create({
    data: {
      slug,
      type: slug === "prod" ? "PRODUCTION" : "STAGING",
      projectId,
      organizationId,
      apiKey: `tr_${slug}_${slugBase}`,
      pkApiKey: `pk_${slug}_${slugBase}`,
      shortcode: `${slug.slice(0, 2)}${suffix()}`,
    },
  });
}

type Seeded = Awaited<ReturnType<typeof seedOrg>>;

function authenticated(seeded: Seeded, environment = seeded.environment) {
  return {
    id: environment.id,
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    slug: environment.slug,
    type: environment.type,
    project: { id: seeded.project.id, externalRef: seeded.project.externalRef },
    organization: { id: seeded.organization.id, slug: seeded.organization.slug },
  } as any;
}

const RUN_START: WatchSpec = {
  kind: "run_start",
  runId: "run_1",
  checkEveryMinutes: 1,
  maxHours: 2,
  note: "tell me when it starts",
};

function draftFor(followUp: Partial<WatchDraft["followUp"]> = {}): WatchDraft {
  return {
    spec: RUN_START,
    followUp: { investigateOnAttention: false, notifyExternally: false, ...followUp },
  };
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

/** Keeps the condition pending with a live target, so a submit always creates a watch. */
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

function submit(args: {
  seeded: Seeded;
  environment?: { id: string; slug: string; type: string };
  chatId?: string;
  clientRequestId?: string;
  draft?: WatchDraft;
  /** Omitted: the real subscribe runs, so a test can assert on real channels. */
  subscribe?: (args: unknown) => Promise<{ ok: boolean; reason?: string; email?: string }>;
}) {
  return submitDashboardAgentWatch({
    environment: authenticated(args.seeded, args.environment as never),
    userId: args.seeded.user.id,
    organizationId: args.seeded.organization.id,
    chatId: args.chatId,
    clientRequestId: args.clientRequestId ?? "wreq_1",
    draft: args.draft ?? draftFor(),
    deps: {
      configured: () => true,
      checkDeps: () => fakeCheckDeps(),
      scheduleTick: async () => {},
      ...(args.subscribe ? { subscribe: args.subscribe as never } : {}),
    },
  });
}

function messagesIn(chatId: string, organizationId: string, userId: string) {
  return getChatMessages(ctx.agentDb, { chatId, userId, organizationId }) as Promise<Array<{
    id: string;
  }> | null>;
}

describe("the submission ledger's tenancy", () => {
  postgresTest(
    "one user, one request id, two organizations: two chats, and neither transcript holds the other's record",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const first = await seedOrg(prisma, "tenancy-a");
      // The same person, in a second organization. `clientRequestId` is client-chosen, so
      // both organizations can send the same one.
      const second = await seedOrg(prisma, "tenancy-b", first.user);

      const inFirst = await submit({ seeded: first, clientRequestId: "wreq_shared" });
      const inSecond = await submit({ seeded: second, clientRequestId: "wreq_shared" });

      // A shared chat id would have let the second organization's records land in the
      // first organization's chat, so this is asserted before anything else.
      const chatIdOf = (result: { chatId?: string }) => result.chatId;
      expect(chatIdOf(inSecond)).not.toBe(chatIdOf(inFirst));

      expect(inFirst.ok && inSecond.ok).toBe(true);
      if (!inFirst.ok || !inSecond.ok) return;

      const firstChat = await messagesIn(inFirst.chatId, first.organization.id, first.user.id);
      const secondChat = await messagesIn(inSecond.chatId, second.organization.id, second.user.id);
      expect(firstChat).toHaveLength(2);
      expect(secondChat).toHaveLength(2);

      // Each chat belongs to exactly one organization, so neither is readable as the other.
      expect(await messagesIn(inSecond.chatId, first.organization.id, first.user.id)).toBeNull();
      expect(await messagesIn(inFirst.chatId, second.organization.id, second.user.id)).toBeNull();
    },
    30_000
  );

  postgresTest(
    "the same chat and request id in a second environment is refused, not replayed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedOrg(prisma, "tenancy-env");
      const staging = await environmentFor(
        prisma,
        seeded.organization.id,
        seeded.project.id,
        `env_${suffix()}`,
        "staging"
      );
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const production = await submit({ seeded, chatId: "chat_1" });
      expect(production.ok).toBe(true);
      if (!production.ok) return;

      // A chat spans environments by design, so the draft matching is not enough: this
      // would otherwise replay production's watch as staging's answer.
      const inStaging = await submit({ seeded, chatId: "chat_1", environment: staging });
      expect(inStaging).toMatchObject({ ok: false, code: "request_conflict" });

      const recorded = await getWatchSubmission(ctx.agentDb, {
        chatId: "chat_1",
        clientRequestId: "wreq_1",
      });
      expect(recorded).toMatchObject({ environmentId: seeded.environment.id });
    },
    30_000
  );

  postgresTest(
    "flipping the email consent under the same request id conflicts and subscribes nobody",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedOrg(prisma, "tenancy-consent");
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const withoutEmail = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor({ notifyExternally: false }),
      });
      expect(withoutEmail.ok).toBe(true);

      // The durable record in the transcript says "chat only". A retry may not quietly
      // turn email on behind it.
      const withEmail = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor({ notifyExternally: true }),
      });
      expect(withEmail).toMatchObject({ ok: false, code: "request_conflict" });

      expect(
        await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
      ).toBe(0);
    },
    30_000
  );

  postgresTest(
    "an email the user asked for and didn't get is stated, and replayed the same way",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedOrg(prisma, "tenancy-email");
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const failing = async () => ({ ok: false, reason: "email_alerts_not_configured" });
      const created = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor({ notifyExternally: true }),
        subscribe: failing,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const line =
        "I couldn't add email notifications, so updates will appear in the dashboard only.";
      expect(JSON.stringify(created.messages[1])).toContain(line);

      // Normalised on the row, so the replay says the same thing rather than guessing.
      expect(
        await getWatchSubmission(ctx.agentDb, { chatId: "chat_1", clientRequestId: "wreq_1" })
      ).toMatchObject({
        externalNotificationStatus: "unavailable",
        externalNotificationReason: "email_alerts_not_configured",
      });

      const retry = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor({ notifyExternally: true }),
        subscribe: failing,
      });
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(JSON.stringify(retry.messages[1])).toContain(line);
    },
    30_000
  );
});

describe("the fire callback", () => {
  function firedRequest(watchId: string, token: string) {
    return {
      request: new Request(
        `https://app.trigger.dev/api/v1/dashboard-agent/watches/${watchId}/fired`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } }
      ),
      params: { watchId },
      context: {} as never,
    } as never;
  }

  postgresTest(
    "sends exactly one alert however many times it is called",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedOrg(prisma, "fired-once");
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const created = await submit({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.watchId) return;

      await transitionWatchCondition(ctx.agentDb, {
        id: created.watchId,
        resolution: "condition_met",
      });

      const token = await signDashboardAgentWatchToken(SESSION_SECRET, {
        watchId: created.watchId,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const first = (await firedAction(firedRequest(created.watchId, token))) as Response;
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, alerted: true });

      // The same token, the same row: a token holder must not be able to mail the user
      // again by repeating the call.
      const second = (await firedAction(firedRequest(created.watchId, token))) as Response;
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ ok: true, alerted: false });

      const alerts = enqueue.mock.calls.filter(
        (call) => (call[0] as { job: string }).job === "v3.deliverDashboardAgentWatchAlert"
      );
      expect(alerts).toHaveLength(1);
    },
    30_000
  );
});

describe("the alert unsubscribe", () => {
  async function seedMember(prisma: PrismaClient, seeded: Seeded) {
    const member = await prisma.user.create({
      data: { email: `member_${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    await prisma.orgMember.create({
      data: { organizationId: seeded.organization.id, userId: member.id, role: "MEMBER" },
    });
    return member;
  }

  async function seedWatchChannel(prisma: PrismaClient, seeded: Seeded, email: string) {
    return prisma.projectAlertChannel.create({
      data: {
        friendlyId: `alert_${suffix()}`,
        name: `Watch alerts for ${email}`,
        projectId: seeded.project.id,
        alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE as never],
        environmentTypes: ["PRODUCTION"],
        type: "EMAIL",
        properties: { email },
        deduplicationKey: watchAlertDeduplicationKey(email),
      },
    });
  }

  function deleteRequest(channelId: string, chatId: string) {
    return {
      request: new Request(`https://app.trigger.dev/api/v1/dashboard-agent/alerts/${channelId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
        body: JSON.stringify({ chatId }),
      }),
      params: { channelId },
      context: {} as never,
    } as never;
  }

  postgresTest(
    "a member can't turn off another member's watch alerts in the same project",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedOrg(prisma, "unsub-owner");
      const caller = await seedMember(prisma, seeded);
      const other = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_caller",
        organizationId: seeded.organization.id,
        userId: caller.id,
      });

      const own = await seedWatchChannel(prisma, seeded, caller.email);
      const theirs = await seedWatchChannel(prisma, seeded, other.email);

      ctx.actor = {
        userId: caller.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      // Same project, same organization, a different owner: out of scope.
      const refused = (await alertChannelAction(
        deleteRequest(theirs.id, "chat_caller")
      )) as Response;
      expect(refused.status).toBe(404);
      expect(
        await prisma.projectAlertChannel.findFirst({ where: { id: theirs.id } })
      ).toMatchObject({ enabled: true, alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE] });

      // The caller's own channel still comes off.
      const removed = (await alertChannelAction(deleteRequest(own.id, "chat_caller"))) as Response;
      expect(removed.status).toBe(200);
      expect(await prisma.projectAlertChannel.findFirst({ where: { id: own.id } })).toMatchObject({
        enabled: false,
        alertTypes: [],
      });
    },
    30_000
  );
});
