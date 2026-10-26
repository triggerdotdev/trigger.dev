import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    SESSION_SECRET: "test-session-secret",
    MAGIC_LINK_SECRET: "test-magic-link-secret",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    MANAGED_WORKER_SECRET: "test-managed-secret",
  });
});

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({
  prisma: undefined as any,
  projectId: "",
  messages: [] as string[],
  locations: [] as string[],
  canCalls: [] as unknown[][],
  denyProduction: false,
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (_options: unknown, handler: any) => (args: any) =>
    handler({
      ...args,
      user: { id: "user_1" },
      ability: {
        can: (...args: unknown[]) => {
          holder.canCalls.push(args);
          return !(
            holder.denyProduction && (args[1] as { envType?: string }).envType === "PRODUCTION"
          );
        },
      },
      params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
    });
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

vi.mock("~/db.server", () => ({
  prisma: new Proxy({}, { get: (_t, key) => holder.prisma[key] }),
  $replica: new Proxy({}, { get: (_t, key) => holder.prisma[key] }),
}));
vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: holder.projectId,
    organizationId: "org_1",
    organization: { featureFlags: {} },
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "STAGING" }),
}));
vi.mock("~/v3/canUseAlertsList.server", () => ({
  requireAlertsEnabledOrRedirect: async () => {},
}));
vi.mock("~/v3/services/alerts/replaceLegacySubscription.server", () => ({
  ReplaceLegacySubscriptionService: class {},
  replaceableEnvironments: async () => [],
}));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async () => ({}),
}));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (path: string, _request: Request, message: string) => {
    holder.messages.push(message);
    holder.locations.push(path);
    return new Response(null, { status: 302, headers: { Location: path } });
  },
  redirectWithErrorMessage: async (_path: string, _request: Request, message: string) => {
    holder.messages.push(`error: ${message}`);
    return new Response(null, { status: 302 });
  },
}));

const { action, loader } =
  await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.legacy/route");

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/alerts/legacy", { method: "POST", body });
}

async function seed(
  prisma: any,
  alertTypes: string[],
  environmentTypes: string[] = ["PRODUCTION"]
) {
  const slug = `p${Math.random().toString(36).slice(2, 8)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  holder.prisma = prisma;
  holder.projectId = project.id;
  holder.messages = [];
  holder.locations = [];
  holder.denyProduction = false;
  return prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_${slug}`,
      name: "ops",
      projectId: project.id,
      alertTypes,
      environmentTypes,
      type: "EMAIL",
      properties: { type: "EMAIL", email: "ops@example.com" },
    },
  });
}

async function types(prisma: any, id: string) {
  const row = await prisma.projectAlertChannel.findFirst({ where: { id } });
  return row && [...row.alertTypes].sort();
}

function remove(channelId: string, alertType: string) {
  return (action as any)({
    request: post({ intent: "deleteLegacyAlert", channelId, alertType }),
    params: {},
    context: {},
  });
}

describe("legacy alerts delete action", () => {
  postgresTest("removes only the named type and keeps the others", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN", "DEPLOYMENT_FAILURE", "ERROR_GROUP"]);
    await remove(channel.id, "DEPLOYMENT_FAILURE");
    expect(await types(prisma, channel.id)).toEqual(["ERROR_GROUP", "TASK_RUN"]);
    expect(holder.messages).toEqual(["Legacy alert deleted"]);
    expect(holder.locations).toEqual(["/orgs/org/projects/proj/env/prod/alerts/legacy"]);
  });

  postgresTest("checks delete for the environment type", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN"]);
    holder.canCalls = [];
    await remove(channel.id, "TASK_RUN");
    expect(holder.canCalls).toEqual([
      ["delete", { type: "alerts", envType: "STAGING" }],
      ["delete", { type: "alerts", envType: "PRODUCTION" }],
    ]);
  });

  postgresTest("leaves another project's channel alone", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN", "DEPLOYMENT_FAILURE"]);
    await seed(prisma, ["TASK_RUN"]);
    await remove(channel.id, "TASK_RUN");
    expect(await types(prisma, channel.id)).toEqual(["DEPLOYMENT_FAILURE", "TASK_RUN"]);
    expect(holder.messages).toEqual(["error: Alert channel not found"]);
  });

  postgresTest("loader checks access for the environment type", async ({ prisma }) => {
    await seed(prisma, ["TASK_RUN"]);
    holder.canCalls = [];
    await (loader as any)({
      request: new Request("http://localhost/alerts/legacy"),
      params: {},
      context: {},
    });
    expect(holder.canCalls).toEqual([
      ["read", { type: "alerts", envType: "STAGING" }],
      ["write", { type: "alerts", envType: "STAGING" }],
      ["delete", { type: "alerts", envType: "STAGING" }],
      ["write", { type: "alerts", envType: "PRODUCTION" }],
      ["write", { type: "alerts", envType: "PRODUCTION" }],
      ["delete", { type: "alerts", envType: "PRODUCTION" }],
    ]);
  });

  postgresTest("loader computes write and delete per channel environments", async ({ prisma }) => {
    const prodChannel = await seed(prisma, ["TASK_RUN"], ["PRODUCTION"]);
    const devChannel = await prisma.projectAlertChannel.create({
      data: {
        friendlyId: "alert_dev",
        name: "dev",
        projectId: holder.projectId,
        alertTypes: ["TASK_RUN"],
        environmentTypes: ["DEVELOPMENT"],
        type: "EMAIL",
        properties: { type: "EMAIL", email: "dev@example.com" },
      },
    });
    holder.denyProduction = true;
    const response = await (loader as any)({
      request: new Request("http://localhost/alerts/legacy"),
      params: {},
      context: {},
    });
    const { legacyChannels } = await response.json();
    const byId = Object.fromEntries(legacyChannels.map((c: any) => [c.id, c]));
    expect(byId[prodChannel.id]).toMatchObject({ canWrite: false, canDelete: false });
    expect(byId[devChannel.id]).toMatchObject({ canWrite: true, canDelete: true });
  });

  postgresTest("lands on alerts when the last legacy alert is deleted", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN"]);
    const response = await remove(channel.id, "TASK_RUN");
    expect(response.status).toBe(302);
    expect(holder.locations).toEqual(["/orgs/org/projects/proj/env/prod/alerts"]);
    expect(holder.messages).toEqual(["Legacy alert deleted"]);
  });

  postgresTest("loader redirects to alerts when there are no legacy alerts", async ({ prisma }) => {
    await seed(prisma, ["ERROR_GROUP"]);
    const thrown = await (loader as any)({
      request: new Request("http://localhost/alerts/legacy"),
      params: {},
      context: {},
    }).catch((e: Response) => e);
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("Location")).toBe("/orgs/org/projects/proj/env/prod/alerts");
  });

  postgresTest("keeps the channel when its last type is removed", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN"]);
    await remove(channel.id, "TASK_RUN");
    expect(await types(prisma, channel.id)).toEqual([]);
  });

  postgresTest("refuses a non-legacy type", async ({ prisma }) => {
    const channel = await seed(prisma, ["ERROR_GROUP"]);
    await remove(channel.id, "ERROR_GROUP");
    expect(await types(prisma, channel.id)).toEqual(["ERROR_GROUP"]);
    expect(holder.messages).toEqual(["error: Not a legacy alert type"]);
  });

  postgresTest(
    "refuses a role denied PRODUCTION on a channel covering PRODUCTION",
    async ({ prisma }) => {
      const channel = await seed(
        prisma,
        ["TASK_RUN", "DEPLOYMENT_FAILURE"],
        ["PRODUCTION", "STAGING"]
      );
      holder.denyProduction = true;
      const status = await remove(channel.id, "TASK_RUN").then(
        (r: Response) => r.status,
        (e: Response) => e.status
      );
      expect(status).toBe(403);
      expect(await types(prisma, channel.id)).toEqual(["DEPLOYMENT_FAILURE", "TASK_RUN"]);
    }
  );

  postgresTest("lets a role denied PRODUCTION delete on a STAGING channel", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN", "DEPLOYMENT_FAILURE"], ["STAGING"]);
    holder.denyProduction = true;
    await remove(channel.id, "TASK_RUN");
    expect(await types(prisma, channel.id)).toEqual(["DEPLOYMENT_FAILURE"]);
  });

  postgresTest("refuses when PRODUCTION is added after the read", async ({ prisma }) => {
    const channel = await seed(prisma, ["TASK_RUN", "DEPLOYMENT_FAILURE"], ["STAGING"]);
    holder.denyProduction = true;
    let raced = false;
    const projectAlertChannel = new Proxy(prisma.projectAlertChannel, {
      get(target, key, receiver) {
        if (key !== "findFirst") return Reflect.get(target, key, receiver);
        return async (args: any) => {
          const result = await target.findFirst(args);
          if (!raced) {
            raced = true;
            await prisma.projectAlertChannel.update({
              where: { id: channel.id },
              data: { environmentTypes: ["STAGING", "PRODUCTION"] },
            });
          }
          return result;
        };
      },
    });
    holder.prisma = new Proxy(prisma, {
      get: (target: any, key) =>
        key === "projectAlertChannel" ? projectAlertChannel : target[key],
    });
    const status = await remove(channel.id, "TASK_RUN").then(
      (r: Response) => r.status,
      (e: Response) => e.status
    );
    expect(status).toBe(403);
    expect(await types(prisma, channel.id)).toEqual(["DEPLOYMENT_FAILURE", "TASK_RUN"]);
  });
});
