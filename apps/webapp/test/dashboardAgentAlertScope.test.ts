import { postgresTest } from "@internal/testcontainers";
import type {
  PrismaClient,
  ProjectAlertChannelType,
  ProjectAlertType,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  AGENT_SCOPE_MAX_PROJECTS,
  AGENT_SCOPED_LIST_LIMIT,
  listScopedAlertChannels,
  listScopedAlerts,
  type AgentAlertScope,
  type AgentScopeOrigin,
} from "~/v3/services/alerts/agentAlertScope.server";
import { createAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { applyAlertsMigration } from "./helpers/alertTables";

vi.setConfig({ testTimeout: 60_000 });

const allowAll = async () => () => true;
let counter = 0;

async function seedUser(prisma: PrismaClient) {
  return prisma.user.create({
    data: { email: `u${++counter}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
}

async function seedProject(prisma: PrismaClient, organizationId: string, deleted = false) {
  const n = ++counter;
  return prisma.project.create({
    data: {
      name: `p${n}`,
      slug: `p${n}`,
      externalRef: `proj_${n}`,
      organizationId,
      deletedAt: deleted ? new Date() : null,
    },
  });
}

async function seedEnvironment(
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  type: RuntimeEnvironmentType,
  extra: { orgMemberId?: string; archivedAt?: Date } = {}
) {
  const n = ++counter;
  return prisma.runtimeEnvironment.create({
    data: {
      slug: `${type.toLowerCase()}${n}`,
      type,
      projectId: project.id,
      organizationId: project.organizationId,
      apiKey: `tr_${n}`,
      pkApiKey: `pk_${n}`,
      shortcode: `s${n}`,
      ...extra,
    },
  });
}

async function seedAlert(
  prisma: PrismaClient,
  env: { id: string; projectId: string; organizationId: string }
) {
  const alert = await createAlert(prisma, {
    organizationId: env.organizationId,
    projectId: env.projectId,
    environmentId: env.id,
    capabilityKey: "queue.depth",
    params: { queue: "worker-1" },
    condition: { operator: ">", value: 100 },
    createdBy: "user_1",
    notifiers: [{ type: "channel", channelId: "chan_1" }],
  });
  return alert.id;
}

async function seedChannel(
  prisma: PrismaClient,
  projectId: string,
  extra: { type?: ProjectAlertChannelType; alertTypes?: ProjectAlertType[] } = {}
) {
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_channel_${++counter}`,
      type: "WEBHOOK",
      name: "hook",
      properties: { url: "https://hooks.example.com/secret-path", secret: "s3cr3t" },
      alertTypes: ["TASK_RUN"],
      projectId,
      ...extra,
    },
  });
  return channel.id;
}

async function seedWorld(prisma: PrismaClient) {
  await applyAlertsMigration(prisma);
  const user = await seedUser(prisma);
  const teammate = await seedUser(prisma);
  const org = await prisma.organization.create({
    data: {
      title: `a${++counter}`,
      slug: `a${counter}`,
      members: {
        create: [
          { userId: user.id, role: "ADMIN" },
          { userId: teammate.id, role: "MEMBER" },
        ],
      },
    },
    include: { members: true },
  });
  const otherOrg = await prisma.organization.create({
    data: {
      title: `b${++counter}`,
      slug: `b${counter}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const memberId = (userId: string) => org.members.find((m) => m.userId === userId)!.id;

  const p1 = await seedProject(prisma, org.id);
  const p2 = await seedProject(prisma, org.id);
  const deleted = await seedProject(prisma, org.id, true);
  const foreign = await seedProject(prisma, otherOrg.id);
  const p1Prod = await seedEnvironment(prisma, p1, "PRODUCTION");
  const p1OtherDev = await seedEnvironment(prisma, p1, "DEVELOPMENT", {
    orgMemberId: memberId(teammate.id),
  });

  const alerts = {
    p1Prod: await seedAlert(prisma, p1Prod),
    p1Staging: await seedAlert(prisma, await seedEnvironment(prisma, p1, "STAGING")),
    p1OwnDev: await seedAlert(
      prisma,
      await seedEnvironment(prisma, p1, "DEVELOPMENT", { orgMemberId: memberId(user.id) })
    ),
    p1OtherDev: await seedAlert(prisma, p1OtherDev),
    p1Archived: await seedAlert(
      prisma,
      await seedEnvironment(prisma, p1, "STAGING", { archivedAt: new Date() })
    ),
    p2Prod: await seedAlert(prisma, await seedEnvironment(prisma, p2, "PRODUCTION")),
    deletedProd: await seedAlert(prisma, await seedEnvironment(prisma, deleted, "PRODUCTION")),
    foreignProd: await seedAlert(prisma, await seedEnvironment(prisma, foreign, "PRODUCTION")),
  };
  const channels = {
    p1: await seedChannel(prisma, p1.id),
    p2: await seedChannel(prisma, p2.id),
    foreign: await seedChannel(prisma, foreign.id),
  };
  const origin: AgentScopeOrigin = {
    userId: user.id,
    organizationId: org.id,
    projectId: p1.id,
    environmentId: p1Prod.id,
  };
  return { origin, alerts, channels, p1OtherDev, p2 };
}

const ids = (result: { alerts: Array<{ alert: { id: string } }> }) =>
  result.alerts.map((a) => a.alert.id).sort();

describe("listScopedAlerts", () => {
  const cases: Array<{ scope: AgentAlertScope; expected: string[] }> = [
    // Catches: the default scope widening beyond the current environment.
    { scope: "environment", expected: ["p1Prod"] },
    // Catches: scope=project handled as the environment; another member's dev or an archived env shown.
    { scope: "project", expected: ["p1Prod", "p1Staging", "p1OwnDev"] },
    // Catches: org leak, another member's dev, archived env or deleted project shown.
    { scope: "organization", expected: ["p1Prod", "p1Staging", "p1OwnDev", "p2Prod"] },
  ];

  for (const { scope, expected } of cases) {
    postgresTest(`scope=${scope} returns exactly its visible alerts`, async ({ prisma }) => {
      const { origin, alerts } = await seedWorld(prisma);
      const result = await listScopedAlerts(prisma, { origin, scope }, allowAll);
      expect(ids(result)).toEqual(expected.map((k) => alerts[k as keyof typeof alerts]).sort());
      expect(result.truncated).toBe(false);
    });
  }

  // Catches: alerts and channels of a project the caller's role cannot read being returned.
  postgresTest("a project the ability denies is hidden", async ({ prisma }) => {
    const { origin, alerts, channels, p2 } = await seedWorld(prisma);
    const denyP2 = async (projectId: string) => () => projectId !== p2.id;

    const scoped = await listScopedAlerts(prisma, { origin, scope: "organization" }, denyP2);
    const listed = await listScopedAlertChannels(prisma, { origin, scope: "organization" }, denyP2);

    expect(ids(scoped)).not.toContain(alerts.p2Prod);
    expect(listed.channels.map((c) => c.id)).toEqual([channels.p1]);
  });

  // Catches: a user outside the origin org reading its alerts and channels.
  postgresTest("a non-member of the origin org gets nothing", async ({ prisma }) => {
    const { origin } = await seedWorld(prisma);
    const outsider = { ...origin, userId: (await seedUser(prisma)).id };

    const scoped = await listScopedAlerts(
      prisma,
      { origin: outsider, scope: "organization" },
      allowAll
    );
    const listed = await listScopedAlertChannels(
      prisma,
      { origin: outsider, scope: "organization" },
      allowAll
    );

    expect(scoped.alerts).toEqual([]);
    expect(listed.channels).toEqual([]);
  });

  // Catches: hidden alerts filling the row cap before visibility filtering.
  postgresTest("hidden alerts above the cap do not crowd out visible ones", async ({ prisma }) => {
    const { origin, alerts, p1OtherDev } = await seedWorld(prisma);
    const later = new Date(Date.now() + 60_000);
    await prisma.alert.createMany({
      data: Array.from({ length: AGENT_SCOPED_LIST_LIMIT + 1 }, (_, i) => ({
        id: `alert_hidden_${i}`,
        organizationId: origin.organizationId,
        projectId: origin.projectId,
        environmentId: p1OtherDev.id,
        capabilityKey: "queue.depth",
        params: { queue: "worker-1" },
        condition: { operator: ">", value: 100 },
        createdBy: "user_1",
        createdAt: later,
      })),
    });

    const result = await listScopedAlerts(prisma, { origin, scope: "project" }, allowAll);

    expect(ids(result)).toEqual([alerts.p1Prod, alerts.p1Staging, alerts.p1OwnDev].sort());
    expect(result.truncated).toBe(false);
  });

  // Catches: the project cap dropping the caller's own project in a large org.
  postgresTest("the origin project survives the project cap", async ({ prisma }) => {
    const { origin, alerts } = await seedWorld(prisma);
    const older = new Date(Date.now() - 86_400_000);
    await prisma.project.createMany({
      data: Array.from({ length: AGENT_SCOPE_MAX_PROJECTS }, (_, i) => ({
        name: `old${i}`,
        slug: `old${i}`,
        externalRef: `proj_old_${counter}_${i}`,
        organizationId: origin.organizationId,
        createdAt: older,
      })),
    });

    const result = await listScopedAlerts(prisma, { origin, scope: "organization" }, allowAll);

    expect(ids(result)).toContain(alerts.p1Prod);
    expect(result.truncated).toBe(true);
  });

  // Catches: truncated reported when exactly `limit` rows exist.
  postgresTest("truncated is set only when rows exceed the limit", async ({ prisma }) => {
    const { origin } = await seedWorld(prisma);
    const alertsAt = (limit: number) =>
      listScopedAlerts(prisma, { origin, scope: "project", limit }, allowAll);
    const channelsAt = (limit: number) =>
      listScopedAlertChannels(prisma, { origin, scope: "organization", limit }, allowAll);

    expect((await alertsAt(3)).truncated).toBe(false);
    expect(await alertsAt(2)).toMatchObject({ truncated: true, alerts: { length: 2 } });
    expect((await channelsAt(2)).truncated).toBe(false);
    expect(await channelsAt(1)).toMatchObject({ truncated: true, channels: { length: 1 } });
  });

  // Catches: environments the ability denies taking slots under the environment cap.
  postgresTest("denied environments do not consume the environment cap", async ({ prisma }) => {
    const { origin, alerts } = await seedWorld(prisma);
    const denyProduction = async () => (type?: RuntimeEnvironmentType) => type !== "PRODUCTION";

    const result = await listScopedAlerts(
      prisma,
      { origin, scope: "project", environmentLimit: 1 },
      denyProduction
    );

    expect(ids(result)).toEqual([alerts.p1Staging]);
  });
});

describe("listScopedAlertChannels", () => {
  // Catches: a channel of another org the user belongs to returned under organization scope.
  postgresTest("organization scope returns only the origin org's channels", async ({ prisma }) => {
    const { origin, channels } = await seedWorld(prisma);
    const result = await listScopedAlertChannels(
      prisma,
      { origin, scope: "organization" },
      allowAll
    );
    expect(result.channels.map((c) => c.id).sort()).toEqual([channels.p1, channels.p2].sort());
  });

  // Catches: every alert type treated as legacy, or legacy=true not filtering.
  postgresTest("legacyAlerts lists only legacy types", async ({ prisma }) => {
    const { origin } = await seedWorld(prisma);
    const modern = await seedChannel(prisma, origin.projectId, { alertTypes: ["ERROR_GROUP"] });
    const mixed = await seedChannel(prisma, origin.projectId, {
      alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE", "ERROR_GROUP"],
    });
    const list = (legacy: boolean) =>
      listScopedAlertChannels(prisma, { origin, scope: "project", legacy }, allowAll);

    const all = (await list(false)).channels;
    expect(all.find((c) => c.id === modern)?.legacyAlerts).toEqual([]);
    expect(all.find((c) => c.id === mixed)?.legacyAlerts).toEqual([
      {
        type: "TASK_RUN",
        label: expect.any(String),
        migration: "replace",
        replaceWith: "runs.failed",
      },
      { type: "DEPLOYMENT_FAILURE", label: expect.any(String), migration: "coming-soon" },
    ]);
    expect((await list(true)).channels.map((c) => c.id)).not.toContain(modern);
  });

  // Catches: the type filter applied after the row cap.
  postgresTest("type filters before the cap", async ({ prisma }) => {
    const { origin } = await seedWorld(prisma);
    await seedChannel(prisma, origin.projectId, { type: "EMAIL" });
    await seedChannel(prisma, origin.projectId, { type: "EMAIL" });

    const { channels } = await listScopedAlertChannels(
      prisma,
      { origin, scope: "organization", type: "WEBHOOK", limit: 1 },
      allowAll
    );

    expect(channels.map((c) => c.type)).toEqual(["WEBHOOK"]);
  });

  // Catches: the channel row, with its secret-bearing properties, spread into the response.
  postgresTest("never returns channel properties", async ({ prisma }) => {
    const { origin } = await seedWorld(prisma);
    const { channels } = await listScopedAlertChannels(
      prisma,
      { origin, scope: "organization" },
      allowAll
    );
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) expect(channel).not.toHaveProperty("properties");
    expect(JSON.stringify(channels)).not.toMatch(/secret/);
  });
});
