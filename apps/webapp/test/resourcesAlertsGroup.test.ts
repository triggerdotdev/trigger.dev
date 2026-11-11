import {
  chats,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { joinPlanItemKeys } from "~/components/alerts/alertCreatedCard";
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
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `ch_${slug}`,
      name: "own",
      type: "EMAIL",
      properties: { type: "EMAIL", email: "a@example.com" },
      alertTypes: ["ERROR_GROUP"],
      deduplicationKey: `dk_${slug}`,
      projectId: project.id,
    },
  });
  const { createAlert } = await import("~/v3/services/alerts/storage/alertStore.server");
  const members = await Promise.all(
    [1, 2].map((n) =>
      createAlert(prisma, {
        organizationId: organization.id,
        projectId: project.id,
        environmentId: environment.id,
        capabilityKey: "queue.depth",
        params: { scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: n, windowSec: 300 },
        createdBy: user.id,
        notifiers: [{ type: "channel", channelId: channel.id }],
      })
    )
  );
  return { user, organization, project, environment, channel, members };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function body(seeded: Seeded, memberAlertIds = seeded.members.map((m) => m.id)) {
  return {
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    environmentId: seeded.environment.id,
    memberAlertIds,
    compositeMode: "any",
    name: "Prod group",
    notifierChannelIds: [seeded.channel.id],
  };
}

async function callAction(userId: string, payload: unknown) {
  const { commitSession, getSession } = await import("~/services/sessionStorage.server");
  const session = await getSession();
  session.set("user", { userId });
  const cookie = (await commitSession(session)).split(";")[0];

  const { action } = await import("~/routes/resources.alerts.group");
  const request = new Request("http://localhost/resources/alerts/group", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
  });
  return action({ request, params: {}, context: {} } as any).catch((e: unknown) => e as Response);
}

describe("resources.alerts.group action", () => {
  test("creates the group and returns its detail path", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const resp = await callAction(seeded.user.id, body(seeded));
    expect(resp.status).toBe(200);
    const group = await prisma.alert.findFirstOrThrow({
      where: { capabilityKey: "alerts.group" },
    });
    expect((await resp.json()).path).toBe(
      `/orgs/${seeded.organization.slug}/projects/${seeded.project.slug}/env/prod/alerts/${group.id}`
    );
    expect(await prisma.alert.count({ where: { groupId: group.id } })).toBe(2);
  });

  test("ignores chatNotifier and stores channel notifiers only", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const resp = await callAction(seeded.user.id, {
      ...body(seeded),
      chatNotifier: "on",
      chatId: "x",
    });
    expect(resp.status).toBe(200);
    const group = await prisma.alert.findFirstOrThrow({
      where: { capabilityKey: "alerts.group" },
    });
    expect(group.notifiers).toEqual([{ type: "channel", channelId: seeded.channel.id }]);
  });

  test("rejects a group without a channel", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const resp = await callAction(seeded.user.id, { ...body(seeded), notifierChannelIds: [] });
    expect(resp.status).toBe(400);
    expect(await prisma.alert.count({ where: { capabilityKey: "alerts.group" } })).toBe(0);
  });

  test("rejects an organization id that does not own the environment", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    await prisma.orgMember.create({
      data: { userId: seeded.user.id, organizationId: other.organization.id, role: "ADMIN" },
    });
    const resp = await callAction(seeded.user.id, {
      ...body(seeded),
      organizationId: other.organization.id,
    });
    expect(resp.status).toBe(403);
    expect(await prisma.alert.count({ where: { capabilityKey: "alerts.group" } })).toBe(0);
  });

  test("rejects a member from another organization and groups nothing", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    const resp = await callAction(
      seeded.user.id,
      body(seeded, [seeded.members[0]!.id, other.members[0]!.id])
    );
    expect(resp.status).toBe(400);
    expect(await prisma.alert.count({ where: { capabilityKey: "alerts.group" } })).toBe(0);
  });

  test.for([{ withChat: true }, { withChat: false }])(
    "transcript card with chat=$withChat",
    async ({ withChat }, { prisma, postgresContainer }) => {
      const seeded = await seed(prisma);
      const agentDb = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
      try {
        await agentDb.db.insert(chats).values({
          id: "chat_mine",
          organizationId: seeded.organization.id,
          userId: seeded.user.id,
          title: "Test chat",
        });
        const resp = await callAction(seeded.user.id, {
          ...body(seeded),
          ...(withChat ? { transcriptChatId: "chat_mine" } : {}),
        });
        expect(resp.status).toBe(200);
        const data = await resp.json();
        const messages = (await getChatMessages(agentDb.db, {
          chatId: "chat_mine",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })) as Array<{ id: string }>;
        expect(messages.map((m) => m.id)).toEqual(
          withChat ? [`alert_created:${data.alertId}`] : []
        );
        expect(data.message?.id).toBe(withChat ? `alert_created:${data.alertId}` : undefined);
      } finally {
        await agentDb.close();
      }
    }
  );

  test("rejects a transcript chat the user does not own", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const resp = await callAction(seeded.user.id, {
      ...body(seeded),
      transcriptChatId: "chat_not_mine",
    });
    expect(resp.status).toBe(400);
    expect(await prisma.alert.count({ where: { capabilityKey: "alerts.group" } })).toBe(0);
  });
});

function memberBody(seeded: Seeded, name: string, channelId = seeded.channel.id) {
  return {
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    environmentId: seeded.environment.id,
    name,
    form: {
      capabilityKey: "runs.failure_rate",
      scopeType: "all",
      conditionKind: "threshold",
      operator: ">",
      value: 10,
      windowMinutes: 10,
      notifierChannelIds: [channelId],
    },
  };
}

function membersBody(seeded: Seeded, members: unknown[]) {
  const { memberAlertIds: _, ...group } = body(seeded);
  return { ...group, members };
}

describe("resources.alerts.group action with new members", () => {
  // Catches: a member with another project's channel or only a chat notifier slipping through.
  test("rejects a member without a valid channel and creates nothing", async ({ prisma }) => {
    const seeded = await seed(prisma);
    const other = await seed(prisma);
    const chatOnly = {
      ...memberBody(seeded, "second"),
      chatNotifier: "on",
      chatId: "chat_1",
      form: { ...memberBody(seeded, "second").form, notifierChannelIds: [] },
    };
    const before = await prisma.alert.count();
    for (const second of [memberBody(seeded, "second", other.channel.id), chatOnly]) {
      const resp = await callAction(
        seeded.user.id,
        membersBody(seeded, [memberBody(seeded, "first"), second])
      );
      expect(resp.status).toBe(400);
    }
    expect(await prisma.alert.count()).toBe(before);
  });

  // Catches: members persisted outside the group's transaction when a later write fails, or a
  // card per member in the chat instead of one group card that marks every member created.
  test("creates the members with the group, or nothing when a member fails", async ({
    prisma,
    postgresContainer,
  }) => {
    const seeded = await seed(prisma);
    const chatId = `chat_${seeded.project.slug}`;
    const viewer = { userId: seeded.user.id, organizationId: seeded.organization.id };
    const agentDb = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 2 });
    await createChat(agentDb.db, { id: chatId, ...viewer });
    const inChat = (name: string, transcriptChatId = chatId) => ({
      ...memberBody(seeded, name),
      transcriptChatId,
      planItemKey: `key_${name}`,
    });
    const before = await prisma.alert.count();
    const unowned = await callAction(
      seeded.user.id,
      membersBody(seeded, [inChat("first"), inChat("second", "chat_other")])
    );
    expect(unowned.status).toBe(400);
    const failed = await callAction(
      seeded.user.id,
      membersBody(seeded, [memberBody(seeded, "first"), memberBody(seeded, "bad\u0000name")])
    );
    expect(failed.status).not.toBe(200);
    expect(await prisma.alert.count()).toBe(before);

    const resp = await callAction(
      seeded.user.id,
      membersBody(seeded, [inChat("first"), inChat("second")])
    );
    expect(resp.status).toBe(200);
    const data = await resp.json();
    const created = await prisma.alert.findMany({
      where: { groupId: data.alertId },
      select: { id: true, name: true },
    });
    expect(Object.fromEntries(created.map((a) => [a.id, a.name]))).toEqual({
      [data.memberAlertIds[0]]: "first",
      [data.memberAlertIds[1]]: "second",
    });
    const messages = ((await getChatMessages(agentDb.db, { chatId, ...viewer })) ?? []) as Array<{
      parts: Array<{ data?: { blocks: Array<{ alertId: string; planItemKey?: string }> } }>;
    }>;
    await agentDb.close();
    const blocks = messages.map((m) => m.parts[1]!.data!.blocks[0]!);
    expect(blocks.map((b) => [b.alertId, b.planItemKey])).toEqual([
      [data.alertId, joinPlanItemKeys(["key_first", "key_second"])],
    ]);
  });
});
