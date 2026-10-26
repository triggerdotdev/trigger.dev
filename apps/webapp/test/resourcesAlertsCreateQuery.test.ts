import { chats, createDashboardAgentDb, getChatMessages } from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { queryAlertRequestBody } from "~/components/alerts/createAlertRequest";
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
      featureFlags: { alertsEnabled: true, hasDashboardAgentAccess: true },
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
  return { user, organization, project, environment };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function sessionCookie(userId: string) {
  const { commitSession, getSession } = await import("~/services/sessionStorage.server");
  const session = await getSession();
  session.set("user", { userId });
  return (await commitSession(session)).split(";")[0];
}

async function callAction(userId: string, body: unknown) {
  const cookie = await sessionCookie(userId);

  const { action } = await import("~/routes/resources.alerts.create");
  const request = new Request("http://localhost/resources/alerts/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return action({ request, params: {}, context: {} } as any).catch((e: unknown) => {
    return e as Response;
  });
}

const QUERY = "SELECT count() AS failures FROM runs WHERE status = 'Failed'";

function queryBody(seeded: Seeded, channelId: string, form: Record<string, unknown> = {}) {
  return {
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    environmentId: seeded.environment.id,
    form: {
      capabilityKey: "custom.query",
      scopeType: "all" as const,
      conditionKind: "threshold" as const,
      operator: ">" as const,
      value: 5,
      windowMinutes: 10,
      query: QUERY,
      querySignalChoice: { mode: "threshold" as const, measure: "failures" },
      notifierChannelIds: [channelId],
      ...form,
    },
  };
}

async function seedWithChannel(prisma: PrismaClient) {
  const seeded = await seed(prisma);
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `ch_${seeded.project.slug}`,
      name: "own",
      type: "EMAIL",
      properties: { type: "EMAIL", email: "a@example.com" },
      alertTypes: ["ERROR_GROUP"],
      deduplicationKey: `ch_${seeded.project.slug}`,
      projectId: seeded.project.id,
    },
  });
  return { seeded, channelId: channel.id };
}

async function alertsFor(prisma: PrismaClient, seeded: Seeded) {
  return prisma.alert.findMany({ where: { projectId: seeded.project.id } });
}

describe("resources.alerts.create action: query alerts", () => {
  test("creates a custom.query alert from the query alert form body", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryAlertRequestBody(
        {
          organizationId: seeded.organization.id,
          projectId: seeded.project.id,
          environmentId: seeded.environment.id,
        },
        {
          query: QUERY,
          name: "failures on runs",
          mode: "threshold",
          measure: "failures",
          operator: ">",
          value: 5,
          windowMinutes: 60,
          expiry: "24h",
          notifiers: [channelId],
        }
      )
    );
    expect(resp.status).toBe(200);
    const [alert] = await alertsFor(prisma, seeded);
    expect(alert.capabilityKey).toBe("custom.query");
    expect(alert.query).toBe(QUERY);
    expect(alert.name).toBe("failures on runs");
    expect(alert.condition).toMatchObject({ kind: "threshold", windowSec: 3600, value: 5 });
    expect((alert.params as any).querySignal).toMatchObject({
      mode: "threshold",
      measure: "failures",
    });
  });

  test("creates a match alert from the chat card body", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const matchQuery = "SELECT run_id, completed_at FROM runs WHERE status = 'Failed'";
    const resp = await callAction(
      seeded.user.id,
      queryAlertRequestBody(
        {
          organizationId: seeded.organization.id,
          projectId: seeded.project.id,
          environmentId: seeded.environment.id,
        },
        {
          query: matchQuery,
          name: "New runs rows",
          mode: "match",
          operator: ">",
          windowMinutes: 60,
          expiry: "none",
          notifiers: [channelId],
        }
      )
    );
    expect(resp.status).toBe(200);
    const [alert] = await alertsFor(prisma, seeded);
    expect(alert.capabilityKey).toBe("custom.query");
    expect(alert.query).toBe(matchQuery);
    expect((alert.params as any).querySignal).toMatchObject({ mode: "match" });
  });

  test("persists the query and a server-derived signal, ignoring a client querySignal", async ({
    prisma,
  }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const body = queryBody(seeded, channelId, {
      querySignal: { v: 1, sources: [], mode: "match" },
    });
    const resp = await callAction(seeded.user.id, {
      ...body,
      querySignal: { v: 1, sources: [], mode: "match" },
    });
    expect(resp.status).toBe(200);
    const [alert] = await alertsFor(prisma, seeded);
    expect(alert.query).toBe(QUERY);
    expect(alert.name).toBe("failures on runs");
    expect((alert.params as any).querySignal).toMatchObject({
      v: 1,
      mode: "threshold",
      measure: "failures",
      sources: [{ sourceId: "runs" }],
    });
  });

  test("rejects a mode the query does not support with the analyzer message", async ({
    prisma,
  }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, {
        conditionKind: "occurrence",
        querySignalChoice: { mode: "match" },
      })
    );
    expect(resp.status).toBe(422);
    expect((await resp.json()).error).toBe(
      "New-row alerts need one result row per source row, without GROUP BY or aggregates."
    );
    expect(await alertsFor(prisma, seeded)).toHaveLength(0);
  });

  test("rejects a measure that is not a candidate", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, { querySignalChoice: { mode: "threshold", measure: "nope" } })
    );
    expect(resp.status).toBe(422);
    expect(await alertsFor(prisma, seeded)).toHaveLength(0);
  });

  test("rejects a condition kind that does not match the mode", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, {
        conditionKind: "absence",
        quietWindowMinutes: 60,
        querySignalChoice: { mode: "threshold", measure: "failures" },
      })
    );
    expect(resp.status).toBe(422);
    expect(await alertsFor(prisma, seeded)).toHaveLength(0);
  });

  for (const windowMinutes of [5, 24 * 60 + 1]) {
    test(`rejects a ${windowMinutes} minute window`, async ({ prisma }) => {
      const { seeded, channelId } = await seedWithChannel(prisma);
      const resp = await callAction(
        seeded.user.id,
        queryBody(seeded, channelId, { windowMinutes })
      );
      expect(resp.status).toBe(422);
      expect((await resp.json()).error).toBe(
        "runs needs a window of at least 10 minutes (max 24 h)"
      );
      expect(await alertsFor(prisma, seeded)).toHaveLength(0);
    });
  }

  test("accepts a window at the strictest floor", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, { windowMinutes: 10 })
    );
    expect(resp.status).toBe(200);
  });

  test("creates an absence alert at the source's floor, below the curated 30 minutes", async ({
    prisma,
  }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const absence = (quietWindowMinutes: number) =>
      callAction(
        seeded.user.id,
        queryBody(seeded, channelId, {
          conditionKind: "absence",
          quietWindowMinutes,
          querySignalChoice: { mode: "absence", measure: "failures" },
        })
      );

    const tooShort = await absence(5);
    expect(tooShort.status).toBe(422);
    expect((await tooShort.json()).error).toBe(
      "runs needs a window of at least 10 minutes (max 24 h)"
    );

    const resp = await absence(10);
    expect(resp.status).toBe(200);
    const [alert] = await alertsFor(prisma, seeded);
    expect((alert.params as any).querySignal.mode).toBe("absence");
    expect(alert.condition).toEqual({ kind: "absence", quietWindowSec: 600 });
  });

  test("keeps the curated 30 minute absence floor", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const curated = (quietWindowMinutes: number) =>
      callAction(
        seeded.user.id,
        queryBody(seeded, channelId, {
          capabilityKey: "runs.created",
          conditionKind: "absence",
          quietWindowMinutes,
          query: undefined,
          querySignalChoice: undefined,
        })
      );

    const tooShort = await curated(10);
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toBe("Quiet window must be at least 1800 seconds");
    expect((await curated(30)).status).toBe(200);
  });

  test("creates a match alert and rejects it with a threshold condition", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const matchQuery = "SELECT run_id, completed_at FROM runs WHERE status = 'Failed'";
    const ok = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, {
        query: matchQuery,
        conditionKind: "occurrence",
        querySignalChoice: { mode: "match" },
      })
    );
    expect(ok.status).toBe(200);
    const bad = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, { query: matchQuery, querySignalChoice: { mode: "match" } })
    );
    expect(bad.status).toBe(422);
  });

  test("rejects a query over 8192 characters", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, { query: `${QUERY} -- ${"x".repeat(8192)}` })
    );
    expect(resp.status).toBe(400);
  });

  test("rejects custom.query without a query", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, { query: undefined })
    );
    expect(resp.status).toBe(422);
    expect(await alertsFor(prisma, seeded)).toHaveLength(0);
  });

  test("still rejects a non-listed capability", async ({ prisma }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const resp = await callAction(
      seeded.user.id,
      queryBody(seeded, channelId, { capabilityKey: "not.a.capability" })
    );
    expect(resp.status).toBe(400);
  });

  test("a query create with transcriptChatId persists the created card", async ({
    prisma,
    postgresContainer,
  }) => {
    const { seeded, channelId } = await seedWithChannel(prisma);
    const url = postgresContainer.getConnectionUri();
    const agentDb = createDashboardAgentDb(url, { max: 2 });
    try {
      await agentDb.db.insert(chats).values({
        id: "chat_mine",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        title: "Test chat",
      });
      const resp = await callAction(
        seeded.user.id,
        queryAlertRequestBody(
          {
            organizationId: seeded.organization.id,
            projectId: seeded.project.id,
            environmentId: seeded.environment.id,
          },
          {
            query: QUERY,
            name: "failures",
            mode: "threshold",
            measure: "failures",
            operator: ">",
            value: 5,
            windowMinutes: 10,
            notifiers: ["chat", channelId],
          },
          { chatId: "chat_mine", transcriptChatId: "chat_mine" }
        )
      );
      expect(resp.status).toBe(200);
      const data = await resp.json();

      const messages = (await getChatMessages(agentDb.db, {
        chatId: "chat_mine",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      })) as Array<{ id: string }>;
      expect(messages.map((m) => m.id)).toContain(`alert_created:${data.alertId}`);
    } finally {
      await agentDb.close();
    }
  });
});
