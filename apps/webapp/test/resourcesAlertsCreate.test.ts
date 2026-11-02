import {
  chats,
  countChatsWithUnreadWork,
  countUserMessages,
  createDashboardAgentDb,
  getChatMessages,
  persistMessages,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { createAlertRequestBody } from "~/components/alerts/createAlertRequest";
import { alertEvaluationJobId } from "~/v3/services/alerts/engine/evaluateAlertJob.server";
import { applyAlertsMigration } from "./helpers/alertTables";
import { alertEngineTest } from "./helpers/alertEngineRedis";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const mocks = vi.hoisted(() => ({
  fixedAlertId: undefined as string | undefined,
  appendFails: false,
  canCalls: [] as unknown[][],
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    dashboardAction: (options: unknown, handler: (args: any) => unknown) =>
      actual.dashboardAction(options, (args: any) =>
        handler({
          ...args,
          ability: new Proxy(args.ability, {
            get: (target, key) =>
              key === "can"
                ? (...canArgs: unknown[]) => {
                    mocks.canCalls.push(canArgs);
                    return target.can(...canArgs);
                  }
                : Reflect.get(target, key),
          }),
        })
      ),
  };
});

vi.mock("~/v3/services/alerts/createAlertFromDraft.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const create = actual.createAlertFromDraft as (...args: unknown[]) => Promise<{ id: string }>;
  return {
    ...actual,
    createAlertFromDraft: async (...args: unknown[]) => {
      const alert = await create(...args);
      return mocks.fixedAlertId ? { ...alert, id: mocks.fixedAlertId } : alert;
    },
  };
});

vi.mock("@internal/dashboard-agent-db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const append = actual.appendChatMessageOnce as (...args: unknown[]) => Promise<boolean>;
  return {
    ...actual,
    appendChatMessageOnce: async (...args: unknown[]) => {
      if (mocks.appendFails) throw new Error("transcript store unavailable");
      return append(...args);
    },
  };
});

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

function validBody(seeded: Seeded) {
  return {
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    environmentId: seeded.environment.id,
    chatNotifier: "on" as const,
    form: {
      capabilityKey: "queue.depth",
      scopeType: "all" as const,
      conditionKind: "threshold" as const,
      operator: ">" as const,
      value: 100,
      windowMinutes: 5,
      notifierChannelIds: [] as string[],
    },
  };
}

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
  return action({ request, params: {}, context: {} } as any).catch((e: unknown) => e as Response);
}

describe("resources.alerts.create action", () => {
  test("rejects missing scopeValue for non-all scope", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const body = validBody(seeded);
    const resp = await callAction(seeded.user.id, {
      ...body,
      form: { ...body.form, scopeType: "queue" as const },
    });
    expect(resp.status).toBe(400);
  });

  async function healthBody(prisma: PrismaClient, seeded: Seeded, extra: Record<string, unknown>) {
    const channel = await prisma.projectAlertChannel.create({
      data: {
        friendlyId: `ch_${Math.random().toString(36).slice(2, 8)}`,
        name: "own",
        type: "EMAIL",
        properties: { type: "EMAIL", email: "a@example.com" },
        alertTypes: ["ERROR_GROUP"],
        deduplicationKey: `dk_${Math.random().toString(36).slice(2, 8)}`,
        projectId: seeded.project.id,
      },
    });
    const body = validBody(seeded);
    return {
      ...body,
      chatNotifier: undefined,
      form: {
        ...body.form,
        capabilityKey: "limits.all",
        conditionKind: "state" as const,
        operator: undefined,
        value: undefined,
        windowMinutes: undefined,
        notifierChannelIds: [channel.id],
        ...extra,
      },
    };
  }

  test("rejects components outside compositeOf and empty signals", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const outside = await callAction(
      seeded.user.id,
      await healthBody(prisma, seeded, { components: ["queue.depth"] })
    );
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toContain("queue.depth");
    const empty = await callAction(
      seeded.user.id,
      await healthBody(prisma, seeded, { signals: [] })
    );
    expect(empty.status).toBe(400);
    const mismatched = await callAction(
      seeded.user.id,
      await healthBody(prisma, seeded, { components: ["limits.queue"], signals: ["limited"] })
    );
    expect(mismatched.status).toBe(400);
  });

  test("accepts limits.all with and without the new fields", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const plain = await callAction(seeded.user.id, await healthBody(prisma, seeded, {}));
    expect(plain.status).toBe(200);
    const withFields = await callAction(
      seeded.user.id,
      await healthBody(prisma, seeded, {
        compositeMode: "all",
        components: ["limits.api"],
        signals: ["limited"],
      })
    );
    expect(withFields.status).toBe(200);
    const rows = await prisma.$queryRaw<{ condition: Record<string, unknown> }[]>`
      SELECT condition FROM "Alert" WHERE "organizationId" = ${seeded.organization.id}
      ORDER BY "createdAt" DESC LIMIT 1`;
    expect(rows[0]!.condition).toMatchObject({
      compositeMode: "all",
      components: ["limits.api"],
      signals: ["limited"],
    });
  });

  test("persists the manual-form body for a 3-limit composite", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const base = await healthBody(prisma, seeded, {});
    const request = createAlertRequestBody(
      {
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
      },
      {
        area: "limits",
        what: "limits.all",
        scope: "all",
        components: ["limits.api", "limits.webhooks.processing", "limits.webhooks.waiters"],
        compositeMode: "all",
        notifiers: [],
      }
    );
    const resp = await callAction(seeded.user.id, {
      ...request,
      chatNotifier: undefined,
      form: { ...request.form, notifierChannelIds: base.form.notifierChannelIds },
    });
    expect(resp.status).toBe(200);
    const rows = await prisma.$queryRaw<{ condition: Record<string, unknown>; name: string }[]>`
      SELECT condition, name FROM "Alert" WHERE "organizationId" = ${seeded.organization.id}
      ORDER BY "createdAt" DESC LIMIT 1`;
    expect(rows[0]!.name).toBe("All of 3 limits");
    expect(rows[0]!.condition).toMatchObject({
      stateKey: "limits.all",
      compositeMode: "all",
      components: ["limits.api", "limits.webhooks.processing", "limits.webhooks.waiters"],
      signals: ["limited", "approaching"],
      params: { utilisationPct: 80 },
    });
  });

  test("rejects foreign channel IDs", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const own = await prisma.projectAlertChannel.create({
      data: {
        friendlyId: "ch_own",
        name: "own",
        type: "EMAIL",
        properties: { type: "EMAIL", email: "a@example.com" },
        alertTypes: ["ERROR_GROUP"],
        deduplicationKey: "ch_own",
        projectId: seeded.project.id,
      },
    });
    const body = validBody(seeded);
    const resp = await callAction(seeded.user.id, {
      ...body,
      chatNotifier: undefined,
      form: { ...body.form, notifierChannelIds: [own.id, "ch_foreign"] },
    });
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toContain("notifiers");
  });

  test("checks write for the environment type", async ({ prisma }) => {
    const seeded = await seed(prisma);
    mocks.canCalls = [];
    await callAction(seeded.user.id, { ...validBody(seeded), chatId: "chat_not_mine" });
    expect(mocks.canCalls).toEqual([["write", { type: "alerts", envType: "PRODUCTION" }]]);
  });

  test("rejects foreign chatId", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const resp = await callAction(seeded.user.id, {
      ...validBody(seeded),
      chatId: "chat_not_mine",
    });
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toContain("chat");
  });

  test("rejects an environment outside the organization and creates no alert", async ({
    prisma,
  }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    const resp = await callAction(seeded.user.id, {
      ...validBody(seeded),
      environmentId: other.environment.id,
      chatId: "chat_x",
    });
    expect(resp.status).toBe(403);
    const rows =
      await prisma.$queryRaw`SELECT id FROM "Alert" WHERE "organizationId" = ${seeded.organization.id}`;
    expect(rows).toHaveLength(0);
  });

  test("rejects a non-member of the organization and creates no alert", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const outsider = await seed(prisma);
    const resp = await callAction(outsider.user.id, { ...validBody(seeded), chatId: "chat_x" });
    expect(resp.status).toBe(302);
    const rows =
      await prisma.$queryRaw`SELECT id FROM "Alert" WHERE "organizationId" = ${seeded.organization.id}`;
    expect(rows).toHaveLength(0);
  });

  test("creates an alert with chat notifier and enqueues its evaluation", async ({
    prisma,
    postgresContainer,
    engine,
  }) => {
    const seeded = await seed(prisma);
    const agentDb = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
    try {
      await agentDb.db.insert(chats).values({
        id: "chat_mine",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        title: "Test chat",
      });
    } finally {
      await agentDb.close();
    }

    const resp = await callAction(seeded.user.id, { ...validBody(seeded), chatId: "chat_mine" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.alertId).toBeDefined();
    expect(await engine.getJob(alertEvaluationJobId(data.alertId))).toBeTruthy();
  });
});

async function createSession(seeded: Seeded): Promise<string> {
  const cookie = await sessionCookie(seeded.user.id);
  const { action } =
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");
  const body = new FormData();
  body.set("intent", "create-session");
  const resp = await action({
    request: new Request("http://localhost/dashboard-agent", {
      method: "POST",
      headers: { Cookie: cookie },
      body,
    }),
    params: {
      organizationSlug: seeded.organization.slug,
      projectParam: seeded.project.slug,
      envParam: seeded.environment.slug,
    },
    context: {},
  } as any);
  expect(resp.status).toBe(200);
  return ((await resp.json()) as { chatId: string }).chatId;
}

async function transcript(url: string, seeded: Seeded, chatId: string) {
  const agentDb = createDashboardAgentDb(url, { max: 2 });
  try {
    return ((await getChatMessages(agentDb.db, {
      chatId,
      userId: seeded.user.id,
      organizationId: seeded.organization.id,
    })) ?? []) as Array<{ id: string; role: string; parts: Array<Record<string, any>> }>;
  } finally {
    await agentDb.close();
  }
}

describe("resources.alerts.create transcript", () => {
  test("the opening leaves the chat read and uncounted", async ({ prisma, postgresContainer }) => {
    const seeded = await seed(prisma);
    await createSession(seeded);
    const viewer = { userId: seeded.user.id, organizationId: seeded.organization.id };
    const agentDb = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
    try {
      expect(await countChatsWithUnreadWork(agentDb.db, viewer)).toBe(0);
      expect(await countUserMessages(agentDb.db, viewer)).toBe(0);
    } finally {
      await agentDb.close();
    }
  });

  test("a custom expiry is stored as ISO, not server-formatted", async ({
    prisma,
    postgresContainer,
  }) => {
    const seeded = await seed(prisma);
    const chatId = await createSession(seeded);
    const expiresAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const body = validBody(seeded);
    const resp = await callAction(seeded.user.id, {
      ...body,
      chatId,
      transcriptChatId: chatId,
      form: { ...body.form, expiresAt },
    });
    expect(resp.status).toBe(200);

    const messages = await transcript(postgresContainer.getConnectionUri(), seeded, chatId);
    const lifetime = messages[1]!.parts[1]!.data.blocks[0].rows[0];
    expect(lifetime).toEqual({
      label: "Lifetime",
      value: `It expires ${expiresAt}.`,
      expiresAt,
    });
    expect(lifetime.value).not.toContain(new Date(expiresAt).toLocaleString());
  });

  test("writes the opening at chat creation and the card after the turns", async ({
    prisma,
    postgresContainer,
  }) => {
    const seeded = await seed(prisma);
    const url = postgresContainer.getConnectionUri();
    const chatId = await createSession(seeded);

    const agentDb = createDashboardAgentDb(url, { max: 2 });
    try {
      await persistMessages(agentDb.db, {
        chatId,
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "watch queue depth" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done, check below." }] },
        ],
      });
    } finally {
      await agentDb.close();
    }

    const resp = await callAction(seeded.user.id, {
      ...validBody(seeded),
      chatId,
      transcriptChatId: chatId,
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();

    const messages = await transcript(url, seeded, chatId);
    expect(messages.map((m) => m.id)).toEqual([
      `alert_creation:opening:${chatId}`,
      "u1",
      "a1",
      `alert_created:${data.alertId}`,
    ]);
    expect(messages[3]).toEqual(data.message);
    const block = messages[3]!.parts[1]!.data.blocks[0];
    expect(block).toMatchObject({
      type: "alert_created",
      id: `alert:${data.alertId}`,
      revision: 0,
      alertId: data.alertId,
    });
    expect(block.rows.map((row: { value: string }) => row.value)).toContain(
      "Notifying: this chat."
    );
    const watching = block.rows.find((row: { label: string }) => row.label === "Watching");
    expect(watching.value).toContain("Production");
  });

  test("creating twice with the same ids writes one opening and one card", async ({
    prisma,
    postgresContainer,
  }) => {
    const seeded = await seed(prisma);
    const chatId = await createSession(seeded);
    mocks.fixedAlertId = "alert_fixed";
    try {
      for (let i = 0; i < 2; i++) {
        const resp = await callAction(seeded.user.id, {
          ...validBody(seeded),
          chatId,
          transcriptChatId: chatId,
        });
        expect(resp.status).toBe(200);
      }
    } finally {
      mocks.fixedAlertId = undefined;
    }

    const messages = await transcript(postgresContainer.getConnectionUri(), seeded, chatId);
    expect(messages.map((m) => m.id)).toEqual([
      `alert_creation:opening:${chatId}`,
      "alert_created:alert_fixed",
    ]);
  });

  test("a failed append still returns the created alert", async ({ prisma, postgresContainer }) => {
    const seeded = await seed(prisma);
    const chatId = await createSession(seeded);
    mocks.appendFails = true;
    let resp: Response;
    try {
      resp = await callAction(seeded.user.id, {
        ...validBody(seeded),
        chatId,
        transcriptChatId: chatId,
      });
    } finally {
      mocks.appendFails = false;
    }
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.alertId).toBeDefined();
    const rows = await prisma.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Alert" WHERE id = ${data.alertId}`;
    expect(rows).toHaveLength(1);

    const messages = await transcript(postgresContainer.getConnectionUri(), seeded, chatId);
    expect(messages.map((m) => m.id)).toEqual([`alert_creation:opening:${chatId}`]);
  });

  test("rejects a transcript chat owned by another user before appending", async ({
    prisma,
    postgresContainer,
  }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    const ownChatId = await createSession(seeded);
    const foreignChatId = await createSession(other);

    const resp = await callAction(seeded.user.id, {
      ...validBody(seeded),
      chatId: ownChatId,
      transcriptChatId: foreignChatId,
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toContain("chat");
    const rows =
      await prisma.$queryRaw`SELECT id FROM "Alert" WHERE "organizationId" = ${seeded.organization.id}`;
    expect(rows).toHaveLength(0);

    const messages = await transcript(postgresContainer.getConnectionUri(), other, foreignChatId);
    expect(messages.map((m) => m.id)).toEqual([`alert_creation:opening:${foreignChatId}`]);
  });
});
