import { createChat, createDashboardAgentDb, getChatMessages } from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { applyAlertsMigration } from "./helpers/alertTables";
import { alertEngineTest } from "./helpers/alertEngineRedis";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const test = alertEngineTest.extend<{ app: void }>({
  app: [
    async ({ postgresContainer, prisma, engine: _engine }, use) => {
      const url = postgresContainer.getConnectionUri();
      process.env.DATABASE_URL = url;
      process.env.DIRECT_URL = url;
      delete process.env.DATABASE_READ_REPLICA_URL;
      delete process.env.DASHBOARD_AGENT_DATABASE_URL;
      process.env.DASHBOARD_AGENT_SECRET_KEY = "test-dashboard-agent-secret";
      (globalThis as any).__trigger_singletons = {};
      vi.resetModules();
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      await applyAlertsMigration(prisma);
      await use();
    },
    { auto: true },
  ],
});

async function seed(prisma: PrismaClient) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: slug,
      slug,
      featureFlags: { alertsEnabled: true },
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: slug.slice(0, 4),
      projectId: project.id,
      organizationId: organization.id,
    },
  });
  const { createAlert } = await import("~/v3/services/alerts/storage/alertStore.server");
  const alert = await createAlert(prisma, {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    capabilityKey: "queue.depth",
    name: "Queue depth",
    params: { scope: { type: "all" } },
    condition: { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
    createdBy: user.id,
    notifiers: [{ type: "channel", channelId: "ch_unused" }],
    attention: "needs_attention",
  });
  return { user, organization, project, environment, alert };
}

async function callAction(userId: string, payload: unknown) {
  const { commitSession, getSession } = await import("~/services/sessionStorage.server");
  const session = await getSession();
  session.set("user", { userId });
  const cookie = (await commitSession(session)).split(";")[0];

  const { action } = await import("~/routes/resources.alerts.action");
  const request = new Request("http://localhost/resources/alerts/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
  });
  return action({ request, params: {}, context: {} } as any).catch((e: unknown) => e as Response);
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function body(seeded: Seeded, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    environmentId: seeded.environment.id,
    alertId: seeded.alert.id,
    intent: "resolve",
    toolCallId: "call_1",
    ...overrides,
  };
}

async function attention(prisma: PrismaClient, id: string) {
  return (await prisma.alert.findUniqueOrThrow({ where: { id } })).attention;
}

describe("resources.alerts.action", () => {
  // Catches: the confirm click not reaching the resolve service, or its result missing from the transcript.
  test("resolves the alert and appends the result to the chat", async ({
    prisma,
    postgresContainer,
  }) => {
    const seeded = await seed(prisma);
    const viewer = { userId: seeded.user.id, organizationId: seeded.organization.id };
    const agentDb = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
    try {
      await createChat(agentDb.db, { id: "chat_mine", ...viewer });
      const resp = await callAction(seeded.user.id, {
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
        alertId: seeded.alert.id,
        intent: "resolve",
        toolCallId: "call_1",
        transcriptChatId: "chat_mine",
      });
      expect(resp.status).toBe(200);
      const stored = await prisma.alert.findUniqueOrThrow({ where: { id: seeded.alert.id } });
      expect(stored.attention).toBe("clear");
      expect(stored.resolvedBy).toBe(seeded.user.id);
      const messages = (await getChatMessages(agentDb.db, {
        chatId: "chat_mine",
        ...viewer,
      })) as Array<{ id: string; parts: Array<{ text?: string }> }>;
      expect(messages.map((m) => [m.id, m.parts[0]?.text])).toEqual([
        ["alert_action:call_1", "` Queue depth ` is resolved. It re-arms and keeps monitoring."],
      ]);
    } finally {
      await agentDb.close();
    }
  });

  // Catches: the route resolving an alert outside the environment it was given.
  test("returns 404 for another organization's alert", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    const resp = await callAction(seeded.user.id, body(seeded, { alertId: other.alert.id }));
    expect(resp.status).toBe(404);
    expect(await attention(prisma, other.alert.id)).toBe("needs_attention");
  });

  // Catches: a missing hasAccessToEnvironment check letting the caller name another org's environment.
  test("returns 403 for another organization's environment", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    const resp = await callAction(
      seeded.user.id,
      body(seeded, {
        projectId: other.project.id,
        environmentId: other.environment.id,
        alertId: other.alert.id,
      })
    );
    expect(resp.status).toBe(403);
    expect(await attention(prisma, other.alert.id)).toBe("needs_attention");
  });

  // Catches: hasAccessToEnvironment letting a member act in a colleague's dev environment.
  test("returns 403 for a colleague's dev environment", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const slug = seeded.organization.slug;
    const colleague = await prisma.user.create({
      data: { email: `c_${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    const member = await prisma.orgMember.create({
      data: { organizationId: seeded.organization.id, userId: colleague.id, role: "ADMIN" },
    });
    const dev = await prisma.runtimeEnvironment.create({
      data: {
        slug: "dev",
        type: "DEVELOPMENT",
        apiKey: `tr_dev_${slug}`,
        pkApiKey: `pk_dev_${slug}`,
        shortcode: `d${slug.slice(0, 3)}`,
        projectId: seeded.project.id,
        organizationId: seeded.organization.id,
        orgMemberId: member.id,
      },
    });
    const { createAlert } = await import("~/v3/services/alerts/storage/alertStore.server");
    const alert = await createAlert(prisma, {
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      environmentId: dev.id,
      capabilityKey: "queue.depth",
      name: "Dev depth",
      params: { scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
      createdBy: colleague.id,
      notifiers: [{ type: "channel", channelId: "ch_unused" }],
      attention: "needs_attention",
    });
    const resp = await callAction(
      seeded.user.id,
      body(seeded, { environmentId: dev.id, alertId: alert.id })
    );
    expect(resp.status).toBe(403);
    expect(await attention(prisma, alert.id)).toBe("needs_attention");
  });

  // Catches: a missing ownsChat check writing into someone else's transcript.
  test("returns 400 for a chat the user does not own", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const resp = await callAction(seeded.user.id, body(seeded, { transcriptChatId: "chat_x" }));
    expect(resp.status).toBe(400);
    expect(await attention(prisma, seeded.alert.id)).toBe("needs_attention");
  });

  // Catches: a repeat click reporting success for an alert that no longer needs attention.
  test("returns 409 when the alert is already resolved", async ({ prisma }) => {
    const seeded = await seed(prisma);
    expect((await callAction(seeded.user.id, body(seeded))).status).toBe(200);
    expect((await callAction(seeded.user.id, body(seeded))).status).toBe(409);
  });
});
