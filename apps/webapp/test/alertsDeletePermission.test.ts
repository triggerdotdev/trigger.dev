import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({ denyDelete: true, deleted: 0 }));
const CHANNELS = vi.hoisted(() => [
  { id: "c1", projectId: "proj_1" },
  { id: "c_foreign", projectId: "proj_2" },
]);

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (options: any, handler: (args: unknown) => unknown) => async (args: any) => {
    const ability = {
      can: (action: string) => !(STATE.denyDelete && action === "delete"),
    };
    const auth = options?.authorization;
    if (auth && !ability.can(auth.action)) {
      throw new Response("Unauthorized", { status: 403 });
    }
    return handler({
      ...args,
      user: { id: "user_1" },
      ability,
      params: { organizationSlug: "org", projectParam: "proj", envParam: "prod" },
    });
  };
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

vi.mock("~/db.server", () => ({
  prisma: {
    projectAlertChannel: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
        const channel = CHANNELS.find((c) => c.id === where.id && c.projectId === where.projectId);
        return channel
          ? { ...channel, name: "chan", alertTypes: [], environmentTypes: ["PRODUCTION"] }
          : null;
      },
      deleteMany: async ({ where }: { where: { id: string; projectId: string } }) => {
        const channel = CHANNELS.find((c) => c.id === where.id && c.projectId === where.projectId);
        if (!channel) return { count: 0 };
        STATE.deleted++;
        return { count: 1 };
      },
    },
  },
  $replica: {},
}));
vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: "proj_1",
    organizationId: "org_1",
    organization: { featureFlags: {} },
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "PRODUCTION" }),
}));
vi.mock("~/v3/canUseAlertsList.server", () => ({
  requireAlertsEnabledOrRedirect: async () => {},
}));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async () => ({}),
}));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async () => new Response(null, { status: 302 }),
  redirectWithErrorMessage: async () => new Response(null, { status: 302 }),
}));
vi.mock("~/v3/services/alerts/deleteLegacySubscription.server", () => ({
  DeleteLegacySubscriptionService: class {
    async call() {
      STATE.deleted++;
    }
  },
}));
vi.mock("~/v3/services/alerts/replaceLegacySubscription.server", () => ({
  ReplaceLegacySubscriptionService: class {},
}));
vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({
  hasLegacyAlerts: async () => ({ hasLegacyAlerts: false }),
}));

let channelsAction: any;
let legacyAction: any;

beforeAll(async () => {
  channelsAction = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.channels/route")
  ).action;
  legacyAction = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.legacy/route")
  ).action;
}, 120_000);

beforeEach(() => {
  STATE.denyDelete = true;
  STATE.deleted = 0;
});

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("http://localhost/alerts", { method: "POST", body });
}

async function status(promise: Promise<unknown>) {
  try {
    return ((await promise) as Response).status;
  } catch (e) {
    return (e as Response).status;
  }
}

const legacyDelete = { intent: "deleteLegacyAlert", channelId: "c1", alertType: "TASK_RUN" };

describe("alert delete requires delete:alerts", () => {
  it("channel delete is 403 when delete is denied but write allowed", async () => {
    const res = await status(channelsAction({ request: post({ action: "delete", id: "c1" }) }));
    expect(res).toBe(403);
    expect(STATE.deleted).toBe(0);
  });

  it("channel delete succeeds when delete is allowed", async () => {
    STATE.denyDelete = false;
    await channelsAction({ request: post({ action: "delete", id: "c1" }) });
    expect(STATE.deleted).toBe(1);
  });

  it("channel delete leaves another project's channel alone", async () => {
    STATE.denyDelete = false;
    await status(channelsAction({ request: post({ action: "delete", id: "c_foreign" }) }));
    expect(STATE.deleted).toBe(0);
  });

  it("legacy alert delete is 403 when delete is denied but write allowed", async () => {
    const res = await status(legacyAction({ request: post(legacyDelete) }));
    expect(res).toBe(403);
    expect(STATE.deleted).toBe(0);
  });

  it("legacy alert delete succeeds when delete is allowed", async () => {
    STATE.denyDelete = false;
    await legacyAction({ request: post(legacyDelete) });
    expect(STATE.deleted).toBe(1);
  });
});
