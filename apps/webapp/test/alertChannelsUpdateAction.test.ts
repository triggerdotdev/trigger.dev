import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const allowAll = { can: () => true };
const holder = vi.hoisted(() => ({
  prisma: undefined as any,
  projectId: "",
  ability: undefined as any,
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (_options: unknown, handler: any) => (args: any) =>
    handler({
      ...args,
      user: { id: "user_1" },
      ability: holder.ability,
      params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
    });
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

vi.mock("~/services/rbac.server", () => ({ rbac: {} }));
vi.mock("~/hooks/useOrganizations", () => ({}));
vi.mock("~/hooks/useProject", () => ({}));
vi.mock("~/hooks/useEnvironment", () => ({}));
vi.mock("~/models/runtimeEnvironment.server", () => ({}));
vi.mock("~/components/BlankStatePanels", () => ({}));
vi.mock("~/components/Feedback", () => ({}));
vi.mock("~/components/alerts/LegacyAlertsBanner", () => ({}));
vi.mock("~/presenters/v3/AlertChannelListPresenter.server", () => ({}));
vi.mock("~/presenters/v3/NewAlertChannelPresenter.server", () => ({}));
vi.mock("~/env.server", () => ({ env: {} }));
vi.mock("~/db.server", () => ({
  prisma: new Proxy({}, { get: (_t, key) => holder.prisma[key] }),
  $replica: {},
}));
vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: holder.projectId,
    organizationId: "org_1",
    organization: { featureFlags: {} },
  }),
}));
vi.mock("~/v3/canUseAlertsList.server", () => ({
  canUseAlertsList: async () => true,
  requireAlertsEnabledOrRedirect: async () => {},
}));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async () => new Response(null, { status: 302 }),
}));
vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({
  hasLegacyAlerts: async () => ({}),
}));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async () => ({}),
}));

const { action } =
  await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.channels/route");

function post(fields: [string, string][]) {
  const body = new FormData();
  for (const [k, v] of fields) body.append(k, v);
  return new Request("http://localhost/alerts/channels", { method: "POST", body });
}

async function run(request: Request) {
  return (action as any)({ request, params: {}, context: {} });
}

async function seed(prisma: any, environmentTypes: string[], ability: any = allowAll) {
  holder.ability = ability;
  const slug = `p${Math.random().toString(36).slice(2, 8)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  holder.prisma = prisma;
  holder.projectId = project.id;
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_${slug}`,
      name: "ops",
      projectId: project.id,
      alertTypes: [],
      environmentTypes,
      type: "EMAIL",
      properties: { type: "EMAIL", email: "ops@example.com" },
    },
  });
  return channel;
}

async function types(prisma: any, id: string) {
  const row = await prisma.projectAlertChannel.findFirst({ where: { id } });
  return [...row.environmentTypes].sort();
}

function update(id: string, environmentTypes: string[], email = "new@example.com") {
  return run(
    post([
      ["action", "update"],
      ["id", id],
      ["type", "EMAIL"],
      ["channelValue", email],
      ...environmentTypes.map((type): [string, string] => ["environmentTypes", type]),
    ])
  );
}

describe("channel update action", () => {
  postgresTest(
    "replaces the environments, removal allowed, and updates the name",
    async ({ prisma }) => {
      const channel = await seed(prisma, ["PRODUCTION", "STAGING"]);
      await update(channel.id, ["DEVELOPMENT", "PREVIEW"]);
      expect(await types(prisma, channel.id)).toEqual(["DEVELOPMENT", "PREVIEW"]);
      const row = await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } });
      expect(row.name).toBe("Email to new@example.com");
      expect(row.properties).toEqual({ email: "new@example.com" });
    }
  );

  postgresTest("a submitted subset removes the other types", async ({ prisma }) => {
    const channel = await seed(prisma, ["PRODUCTION", "STAGING"]);
    await update(channel.id, ["PRODUCTION"]);
    expect(await types(prisma, channel.id)).toEqual(["PRODUCTION"]);
  });

  postgresTest("leaves another project's channel alone", async ({ prisma }) => {
    const channel = await seed(prisma, ["PRODUCTION", "STAGING"]);
    await seed(prisma, ["PRODUCTION"]);
    await run(
      post([
        ["action", "disable"],
        ["id", channel.id],
      ])
    ).catch(() => undefined);
    await update(channel.id, ["DEVELOPMENT"]).catch(() => undefined);
    const row = await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } });
    expect(row.enabled).toBe(true);
    expect([...row.environmentTypes].sort()).toEqual(["PRODUCTION", "STAGING"]);
  });

  postgresTest("an empty environment selection changes nothing", async ({ prisma }) => {
    const channel = await seed(prisma, ["PRODUCTION", "STAGING"]);
    await update(channel.id, []);
    expect(await types(prisma, channel.id)).toEqual(["PRODUCTION", "STAGING"]);
    const row = await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } });
    expect(row.name).toBe("ops");
  });
});

const noProductionRole = {
  can: (action: string, resource: { type: string; envType?: string }) =>
    ["write", "delete"].includes(action) &&
    resource.type === "alerts" &&
    resource.envType !== "PRODUCTION",
};

async function status(promise: Promise<unknown>) {
  try {
    return ((await promise) as Response).status;
  } catch (e) {
    return (e as Response).status;
  }
}

describe("channel action authorizes every affected environment", () => {
  postgresTest("denies changing a channel that covers PRODUCTION", async ({ prisma }) => {
    const channel = await seed(prisma, ["PRODUCTION", "DEVELOPMENT"], noProductionRole);
    expect(await status(update(channel.id, ["DEVELOPMENT"]))).toBe(403);
    for (const action of ["disable", "delete"]) {
      expect(
        await status(
          run(
            post([
              ["action", action],
              ["id", channel.id],
            ])
          )
        )
      ).toBe(403);
    }
    const row = await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } });
    expect(row.enabled).toBe(true);
    expect(row.name).toBe("ops");
    expect([...row.environmentTypes].sort()).toEqual(["DEVELOPMENT", "PRODUCTION"]);
  });

  postgresTest("denies enabling a channel that covers PRODUCTION", async ({ prisma }) => {
    const channel = await seed(prisma, ["PRODUCTION"], noProductionRole);
    await prisma.projectAlertChannel.update({
      where: { id: channel.id },
      data: { enabled: false },
    });
    const request = post([
      ["action", "enable"],
      ["id", channel.id],
    ]);
    expect(await status(run(request))).toBe(403);
    const row = await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } });
    expect(row.enabled).toBe(false);
  });

  postgresTest("denies moving a PRODUCTION channel to DEVELOPMENT", async ({ prisma }) => {
    const channel = await seed(prisma, ["PRODUCTION"], noProductionRole);
    expect(await status(update(channel.id, ["DEVELOPMENT"]))).toBe(403);
    expect(await types(prisma, channel.id)).toEqual(["PRODUCTION"]);
  });

  postgresTest("denies adding PRODUCTION to a DEVELOPMENT channel", async ({ prisma }) => {
    const channel = await seed(prisma, ["DEVELOPMENT"], noProductionRole);
    expect(await status(update(channel.id, ["DEVELOPMENT", "PRODUCTION"]))).toBe(403);
    expect(await types(prisma, channel.id)).toEqual(["DEVELOPMENT"]);
  });

  postgresTest("allows the same role on a DEVELOPMENT channel", async ({ prisma }) => {
    const channel = await seed(prisma, ["DEVELOPMENT"], noProductionRole);
    expect(await status(update(channel.id, ["DEVELOPMENT"]))).toBe(302);
    expect(
      await status(
        run(
          post([
            ["action", "disable"],
            ["id", channel.id],
          ])
        )
      )
    ).toBe(302);
    expect(
      await status(
        run(
          post([
            ["action", "delete"],
            ["id", channel.id],
          ])
        )
      )
    ).toBe(302);
    expect(await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } })).toBeNull();
  });
});

function widenAfterFirstRead(prisma: any, id: string) {
  let raced = false;
  const projectAlertChannel = new Proxy(prisma.projectAlertChannel, {
    get(target, key, receiver) {
      if (key !== "findFirst") return Reflect.get(target, key, receiver);
      return async (args: unknown) => {
        const result = await target.findFirst(args);
        if (!raced) {
          raced = true;
          await prisma.projectAlertChannel.update({
            where: { id },
            data: { environmentTypes: ["DEVELOPMENT", "PRODUCTION"] },
          });
        }
        return result;
      };
    },
  });
  return new Proxy(prisma, {
    get: (target, key) => (key === "projectAlertChannel" ? projectAlertChannel : target[key]),
  });
}

describe("channel action binds the write to the authorized environments", () => {
  for (const action of ["enable", "disable", "delete", "update"]) {
    postgresTest(`${action} is denied when PRODUCTION is added mid-request`, async ({ prisma }) => {
      const channel = await seed(prisma, ["DEVELOPMENT"], noProductionRole);
      await prisma.projectAlertChannel.update({
        where: { id: channel.id },
        data: { enabled: action !== "enable" },
      });
      holder.prisma = widenAfterFirstRead(prisma, channel.id);
      const request =
        action === "update"
          ? update(channel.id, ["DEVELOPMENT"])
          : run(
              post([
                ["action", action],
                ["id", channel.id],
              ])
            );
      expect(await status(request)).toBe(403);
      const row = await prisma.projectAlertChannel.findFirst({ where: { id: channel.id } });
      expect(row.enabled).toBe(action !== "enable");
      expect(row.name).toBe("ops");
      expect([...row.environmentTypes].sort()).toEqual(["DEVELOPMENT", "PRODUCTION"]);
    });
  }
});
