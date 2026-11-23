import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  canCalls: [] as Array<[string, Record<string, unknown>]>,
  // A rule with an environment condition: nothing is triggered or written in Production.
  denyProduction: false,
  environmentType: "PRODUCTION",
  messages: [] as string[],
}));

vi.mock("~/env.server", async (importOriginal) => {
  const original = (await importOriginal()) as { env: Record<string, unknown> };
  return { ...original, env: { ...original.env, WEBHOOK_ENABLED: "1" } };
});
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "user_1" }),
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "proj_1", slug: "proj", organizationId: "org_1" }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", slug: "prod", type: STATE.environmentType }),
}));
vi.mock("~/v3/webhooksAccess.server", () => ({
  requireWebhooksAccess: async () => {},
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      ability: {
        can: (action: string, resource: Record<string, unknown>) => {
          STATE.canCalls.push([action, resource]);
          return !(STATE.denyProduction && resource.envType === "PRODUCTION");
        },
      },
    }),
  },
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {}, webhookReplica: {} }));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server", () => ({
  webhookDeliveriesRepository: () => ({
    getDelivery: async () => ({ id: "delivery_1", createdAt: new Date(0) }),
  }),
}));
vi.mock("~/v3/webhookEngine.server", () => ({
  webhookEngine: {
    replayDelivery: async ({
      authorize,
    }: {
      authorize: (subscribers: Array<{ id: string; type: string; taskId: string }>) => string[];
    }) => {
      const denied = authorize([
        { id: "sub_1", type: "task", taskId: "orders.created" },
        { id: "sub_2", type: "session", taskId: "support.agent" },
      ]);
      return denied.length > 0
        ? { outcome: "forbidden", denied }
        : { outcome: "replayed", deliveryFriendlyId: "whd_new" };
    },
  },
}));
vi.mock("~/v3/webhookLimits.server", () => ({
  webhookLimitsForEnvironment: async () => ({ deliveryRetentionDays: 7 }),
}));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (_path: string, _request: Request, message: string) => {
    STATE.messages.push(message);
    return new Response(null, { status: 302 });
  },
  redirectWithErrorMessage: async (_path: string, _request: Request, message: string) => {
    STATE.messages.push(`error: ${message}`);
    return new Response(null, { status: 302 });
  },
}));

let action: any;

beforeAll(async () => {
  action = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks.deliveries.$deliveryParam/route")
  ).action;
}, 120_000);

beforeEach(() => {
  STATE.canCalls = [];
  STATE.denyProduction = false;
  STATE.environmentType = "PRODUCTION";
  STATE.messages = [];
});

const params = {
  organizationSlug: "org",
  projectParam: "proj",
  envParam: "prod",
  deliveryParam: "whd_1",
};

function replay() {
  return action({
    request: new Request("http://localhost/deliveries/whd_1", { method: "POST" }),
    params,
  });
}

describe("dashboard delivery replay permission checks", () => {
  // Catches: a per-subscriber check without the environment type, which a rule with an
  // environment condition can't apply to.
  it("asks about every subscriber with the delivery's environment type", async () => {
    await replay();
    expect(STATE.canCalls).toEqual([
      ["write", { type: "webhooks", envType: "PRODUCTION" }],
      ["trigger", { type: "tasks", id: "orders.created", envType: "PRODUCTION" }],
      ["trigger", { type: "tasks", id: "support.agent", envType: "PRODUCTION" }],
      ["write", { type: "sessions", envType: "PRODUCTION" }],
    ]);
    expect(STATE.messages).toEqual(["Replayed as whd_new"]);
  });

  it("replays in an environment the rule allows", async () => {
    STATE.denyProduction = true;
    STATE.environmentType = "STAGING";
    await replay();
    expect(STATE.messages).toEqual(["Replayed as whd_new"]);
  });
});
