import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({ alerts: false, watch: true, admin: false, configured: "1" }));

vi.mock("~/env.server", () => ({
  env: {
    get ALERTS_ENABLED() {
      return STATE.configured;
    },
  },
}));
vi.mock("~/v3/featureFlags.server", () => ({
  makeFlag: () => async (opts: { key: string }) =>
    opts.key === "alertsEnabled" ? STATE.alerts : STATE.watch,
}));
vi.mock("~/db.server", () => ({
  prisma: { user: { findFirst: async () => ({ admin: STATE.admin }) } },
  $replica: {},
}));
vi.mock("~/services/uatRoutePreamble.server", () => ({
  authenticateUatOrApiRequest: async () => ({
    userActor: { client: "dashboard-agent", environmentId: "env_1", userId: "user_1" },
  }),
}));
vi.mock("~/services/dashboardAgentAlertContext.server", () => ({
  resolveAgentAlertContext: async () => ({
    ok: true,
    environment: {
      organizationId: "org_1",
      organization: { slug: "acme", featureFlags: {} },
      project: { id: "proj_1" },
    },
  }),
}));
vi.mock("~/services/dashboardAgentWatchAlerts.server", () => ({
  canUseDashboardAgentEmailAlerts: async () => ({ allowed: false, reason: "email_off" }),
  DASHBOARD_AGENT_WATCH_ALERT_TYPE: "DASHBOARD_AGENT_WATCH",
  subscribeChannelToWatchAlerts: async () => {},
  watchAlertDeduplicationKey: () => "k",
}));
vi.mock("~/models/projectAlert.server", () => ({
  ProjectAlertEmailProperties: { safeParse: () => ({ success: false }) },
  ProjectAlertSlackProperties: { safeParse: () => ({ success: false }) },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug() {}, error() {}, warn() {}, info() {} },
}));

import { action } from "~/routes/api.v1.dashboard-agent.alerts";

const call = () =>
  action({
    request: new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({ chatId: "c1", channel: "email" }),
    }),
    params: {},
    context: {},
  } as never);

describe("api.v1.dashboard-agent.alerts gate", () => {
  beforeEach(() => {
    STATE.alerts = false;
    STATE.watch = true;
    STATE.admin = false;
    STATE.configured = "1";
  });

  it("404s a non-admin with alertsEnabled off even if the watch flag is on", async () => {
    expect((await call()).status).toBe(404);
  });

  it("passes the gate for an admin with alertsEnabled off when alerts are configured", async () => {
    STATE.admin = true;
    expect((await call()).status).toBe(403);
  });

  it("404s an admin with alertsEnabled off when alerts are not configured", async () => {
    STATE.admin = true;
    STATE.configured = "";
    expect((await call()).status).toBe(404);
  });

  it("passes the gate when alertsEnabled is on", async () => {
    STATE.alerts = true;
    expect((await call()).status).toBe(403);
  });

  it("404s when the watch flag is off", async () => {
    STATE.alerts = true;
    STATE.watch = false;
    expect((await call()).status).toBe(404);
  });
});
