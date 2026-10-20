import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const builder = vi.hoisted(() => ({ loader: undefined as any, action: undefined as any }));
const calls = vi.hoisted(() => ({ service: [] as unknown[], messages: [] as string[] }));
const result = vi.hoisted(() => ({
  value: { replaced: true, alertIds: ["a1", "a2"] } as {
    replaced: boolean;
    alertIds: string[];
    skipped?: number;
  },
}));

const remaining = vi.hoisted(() => ({ value: true }));
const CHANNELS = vi.hoisted(() => [
  { id: "ch_1", projectId: "proj_1", environmentTypes: ["DEVELOPMENT"] },
  { id: "ch_2", projectId: "proj_1", environmentTypes: ["DEVELOPMENT"] },
  { id: "ch_prod", projectId: "proj_1", environmentTypes: ["PRODUCTION", "DEVELOPMENT"] },
  { id: "ch_foreign", projectId: "proj_2", environmentTypes: ["DEVELOPMENT"] },
]);
const ENVIRONMENTS = vi.hoisted(() => [
  { id: "env_1", projectId: "proj_1", type: "DEVELOPMENT" },
  { id: "env_2", projectId: "proj_1", type: "PRODUCTION" },
  { id: "env_3", projectId: "proj_1", type: "STAGING" },
]);
const AUTH = vi.hoisted(() => ({
  calls: [] as unknown[][],
  deny: undefined as string | undefined,
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (slot: "loader" | "action") => (options: unknown, handler: any) => {
    builder[slot] = options;
    return (args: any) =>
      handler({
        ...args,
        user: { id: "user_1" },
        ability: {
          can: (action: string, resource: { envType?: string }) => {
            AUTH.calls.push([action, resource]);
            return resource.envType !== AUTH.deny;
          },
        },
      });
  };
  return { dashboardLoader: wrap("loader"), dashboardAction: wrap("action") };
});

vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({ id: "proj_1", organizationId: "org_1" }),
}));

vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (path: string, _request: Request, message: string) => {
    calls.messages.push(message);
    return new Response(null, { status: 302, headers: { Location: path } });
  },
  redirectWithErrorMessage: async (path: string, _request: Request, message: string) => {
    calls.messages.push(`error: ${message}`);
    return new Response(null, { status: 302, headers: { Location: path } });
  },
}));

vi.mock("~/v3/services/alerts/replaceLegacySubscription.server", () => ({
  ReplaceLegacySubscriptionService: class {
    async call(params: unknown) {
      calls.service.push(params);
      return result.value;
    }
  },
  replaceableEnvironments: async () => [],
}));

vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({
  hasLegacyAlerts: async () => ({
    hasLegacyAlerts: remaining.value,
    hasMigratableLegacyAlerts: remaining.value,
  }),
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("@internal/dashboard-agent-db", () => ({ chatExists: async () => true }));

vi.mock("~/db.server", () => ({
  prisma: {
    user: { findFirst: async () => ({ admin: false }) },
    runtimeEnvironment: {
      findMany: async ({ where }: { where: { id: { in: string[] }; projectId: string } }) =>
        ENVIRONMENTS.filter(
          (e) => where.id.in.includes(e.id) && e.projectId === where.projectId
        ).map(({ type }) => ({ type })),
    },
    projectAlertChannel: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) =>
        CHANNELS.find((c) => c.id === where.id && c.projectId === where.projectId) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] }; projectId: string } }) =>
        CHANNELS.filter((c) => where.id.in.includes(c.id) && c.projectId === where.projectId).map(
          ({ id }) => ({ id })
        ),
    },
  },
  $replica: {
    organization: { findFirst: async () => ({ featureFlags: { alertsEnabled: true } }) },
  },
}));

let action: (args: unknown) => Promise<Response>;

beforeAll(async () => {
  const route =
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.legacy/route");
  action = route.action as unknown as typeof action;
}, 120_000);

const params = { organizationSlug: "o", projectParam: "p", envParam: "prod" };

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/orgs/o/projects/p/env/prod/alerts/legacy", {
    method: "POST",
    body,
  });
}

describe("legacy alerts replace action", () => {
  beforeEach(() => {
    calls.service = [];
    calls.messages = [];
    result.value = { replaced: true, alertIds: ["a1", "a2"] };
    remaining.value = true;
    AUTH.calls = [];
    AUTH.deny = undefined;
  });

  it("checks write for every picked environment type", async () => {
    AUTH.deny = "PRODUCTION";
    const error = await action({
      request: post({
        intent: "replace",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        environmentIds: "env_1,env_2",
        notifierChannelIds: "ch_1",
      }),
      params,
      context: {},
    }).catch((thrown: unknown) => thrown);
    expect((error as Response).status).toBe(403);
    expect(AUTH.calls).toEqual([
      ["write", { type: "alerts", envType: "DEVELOPMENT" }],
      ["write", { type: "alerts", envType: "PRODUCTION" }],
    ]);
    expect(calls.service).toEqual([]);
  });

  it.each([
    ["ch_prod", 403],
    ["ch_1", 200],
  ])(
    "replacing %s from DEVELOPMENT with PRODUCTION denied responds %i",
    async (channelId, status) => {
      AUTH.deny = "PRODUCTION";
      const response = await action({
        request: post({
          intent: "replace",
          channelId,
          alertType: "TASK_RUN",
          environmentIds: "env_1",
          notifierChannelIds: "ch_1",
        }),
        params,
        context: {},
      }).catch((thrown: Response) => thrown);
      expect(response.status).toBe(status);
      expect(calls.service).toHaveLength(status === 200 ? 1 : 0);
    }
  );

  it("rejects a task scope without a task", async () => {
    const response = await action({
      request: post({
        intent: "replace",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        environmentIds: "env_1",
        scopeType: "task",
        notifierChannelIds: "ch_1",
      }),
      params,
      context: {},
    });
    expect(response.status).toBe(400);
    expect(calls.service).toEqual([]);
  });

  it("requires write on alerts, same as the loader's project scope", () => {
    expect(builder.action.authorization).toEqual({
      action: "write",
      resource: { type: "alerts" },
    });
    expect(builder.loader.authorization).toEqual({
      action: "read",
      resource: { type: "alerts" },
    });
  });

  it("replaces the subscription in the selected environments and returns the count", async () => {
    const response = await action({
      request: post({
        intent: "replace",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        environmentIds: "env_1,env_2",
        notifierChannelIds: "ch_1,ch_2",
        chatId: "chat_1",
        value: "0",
        windowMinutes: "10",
        scopeType: "all",
      }),
      params,
      context: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      count: 2,
      message: "Created 2 alerts",
      legacyRemaining: true,
    });
    expect(calls.service).toEqual([
      {
        projectId: "proj_1",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        userId: "user_1",
        environmentIds: ["env_1", "env_2"],
        value: 0,
        windowSec: 600,
        expiresAt: undefined,
        scope: undefined,
        notifiers: [
          { type: "channel", channelId: "ch_1" },
          { type: "channel", channelId: "ch_2" },
          { type: "chat", chatId: "chat_1", userId: "user_1" },
        ],
        authorize: expect.any(Function),
      },
    ]);
  });

  it("reports no legacy alerts remaining after the last one is replaced", async () => {
    remaining.value = false;
    const response = await action({
      request: post({
        intent: "replace",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        environmentIds: "env_1",
        notifierChannelIds: "ch_1",
      }),
      params,
      context: {},
    });
    expect(await response.json()).toMatchObject({ legacyRemaining: false });
  });

  it("reports environments skipped for a missing scope", async () => {
    result.value = { replaced: true, alertIds: ["a1"], skipped: 2 };
    const response = await action({
      request: post({
        intent: "replace",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        environmentIds: "env_1,env_2,env_3",
        scopeType: "task",
        scopeValue: "my-task",
        notifierChannelIds: "ch_1",
      }),
      params,
      context: {},
    });
    expect(await response.json()).toEqual({
      count: 1,
      message: "Created 1 alert (skipped 2: scope not found)",
      legacyRemaining: true,
    });
    expect(calls.service).toMatchObject([{ scope: { type: "task", taskIdentifier: "my-task" } }]);
  });

  it("rejects a notifier channel outside the project", async () => {
    const response = await action({
      request: post({
        intent: "replace",
        channelId: "ch_1",
        alertType: "TASK_RUN",
        environmentIds: "env_1",
        notifierChannelIds: "ch_1,ch_foreign",
      }),
      params,
      context: {},
    });
    expect(response.status).toBe(400);
    expect(calls.service).toEqual([]);
  });

  it("rejects a replace without environments", async () => {
    const response = await action({
      request: post({ intent: "replace", channelId: "ch_1", alertType: "TASK_RUN" }),
      params,
      context: {},
    });
    expect(response.status).toBe(400);
    expect(calls.service).toEqual([]);
  });

  it("rejects a malformed request without calling the service", async () => {
    await action({ request: post({ channelId: "ch_1" }), params, context: {} });
    expect(calls.service).toEqual([]);
    expect(calls.messages).toEqual(["error: Invalid request"]);
  });
});
