import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  channels: [] as { alertTypes: string[] }[],
  canCalls: [] as unknown[][],
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: () => async () => new Response(),
  dashboardLoader:
    (_options: unknown, handler: (args: unknown) => unknown) =>
    (args: { request: Request; params: unknown }) =>
      handler({
        params: args.params,
        request: args.request,
        user: { id: "user_1" },
        ability: {
          can: (...args: unknown[]) => {
            STATE.canCalls.push(args);
            return true;
          },
        },
      }),
}));

vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: "proj_1",
    organizationId: "org_1",
    organization: { featureFlags: {} },
  }),
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "DEVELOPMENT" }),
}));

vi.mock("~/v3/canUseAlertsList.server", () => ({ canUseAlertsList: async () => true }));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => false,
}));

vi.mock("~/presenters/v3/AlertsListPresenter.server", () => ({
  AlertsListPresenter: class {
    async call() {
      return { rows: [] };
    }
  },
}));

vi.mock("~/db.server", () => ({
  prisma: {
    projectAlertChannel: {
      findMany: async ({ where }: { where: { alertTypes: { hasSome: string[] } } }) =>
        STATE.channels.filter((c) =>
          c.alertTypes.some((t) => where.alertTypes.hasSome.includes(t))
        ),
    },
  },
  $replica: {},
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));

let loader: (args: never) => Promise<{ data?: unknown }>;

beforeAll(async () => {
  const route =
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route");
  loader = route.loader as unknown as typeof loader;
}, 120_000);

async function run() {
  const result = await loader({
    request: new Request("http://localhost/orgs/o/projects/p/env/dev/alerts"),
    params: { organizationSlug: "o", projectParam: "p", envParam: "dev" },
    context: {},
  } as never);
  return (result.data ?? result) as {
    hasLegacyAlerts: boolean;
    hasMigratableLegacyAlerts: boolean;
    canWrite: boolean;
  };
}

describe("alerts list loader hasLegacyAlerts", () => {
  beforeEach(() => {
    STATE.channels = [];
    STATE.canCalls = [];
  });

  it("checks read, write and delete for the environment type", async () => {
    await run();
    expect(STATE.canCalls).toEqual([
      ["read", { type: "alerts", envType: "DEVELOPMENT" }],
      ["write", { type: "alerts", envType: "DEVELOPMENT" }],
      ["delete", { type: "alerts", envType: "DEVELOPMENT" }],
    ]);
  });

  it("is false with no legacy channels", async () => {
    expect((await run()).hasLegacyAlerts).toBe(false);
  });

  it("is true with a legacy channel", async () => {
    STATE.channels = [{ alertTypes: ["TASK_RUN"] }];
    const data = await run();
    expect(data.hasLegacyAlerts).toBe(true);
    expect(data.hasMigratableLegacyAlerts).toBe(true);
  });

  it("is legacy but not migratable with only coming-soon channels", async () => {
    STATE.channels = [{ alertTypes: ["DEPLOYMENT_FAILURE"] }];
    const data = await run();
    expect(data.hasLegacyAlerts).toBe(true);
    expect(data.hasMigratableLegacyAlerts).toBe(false);
  });

  it("is false when channels only have migrated or agent types", async () => {
    STATE.channels = [{ alertTypes: ["DASHBOARD_AGENT_WATCH"] }, { alertTypes: ["ERROR_GROUP"] }];
    expect((await run()).hasLegacyAlerts).toBe(false);
  });
});
