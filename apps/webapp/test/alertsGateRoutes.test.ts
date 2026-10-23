import type * as AlertsGate from "~/v3/canUseAlertsList.server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  enabled: false,
  denyAlertsRead: false,
  denyAlertsWrite: false,
  denyProduction: false,
  denyProductionWrites: false,
  created: undefined as unknown,
  envType: "DEVELOPMENT",
  passedGate: false,
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (options: any, handler: (args: unknown) => unknown) => async (args: any) => {
    const ability = {
      can: (action: string, resource: { type: string; envType?: string }) =>
        !(
          resource.type === "alerts" &&
          ((STATE.denyAlertsRead && action === "read") ||
            (STATE.denyAlertsWrite && action === "write") ||
            (STATE.denyProduction && resource.envType === "PRODUCTION") ||
            (STATE.denyProductionWrites && action !== "read" && resource.envType === "PRODUCTION"))
        ),
    };
    const auth = options?.authorization;
    if (auth && !ability.can(auth.action, auth.resource)) {
      throw new Response("Unauthorized", { status: 403 });
    }
    return handler({ ...args, user: { id: "user_1" }, ability });
  };
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

vi.mock("~/services/session.server", () => ({
  requireUserId: async () => "user_1",
  hasAdminDisplayAccess: () => false,
}));

vi.mock("~/db.server", () => ({
  prisma: {
    organizationIntegration: { findFirst: async () => ({ id: "int_1" }) },
    user: { findFirst: async () => ({ admin: true }) },
  },
  $replica: { organization: { findFirst: async () => ({ featureFlags: {} }) } },
}));

vi.mock("~/models/project.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findProjectBySlug: async () => ({
    id: "proj_1",
    slug: "p",
    externalRef: "proj_ref",
    organizationId: "org_1",
  }),
  findProjectWithOrgFlagsBySlug: async () => ({
    id: "proj_1",
    slug: "p",
    externalRef: "proj_ref",
    organizationId: "org_1",
    organization: { featureFlags: {} },
  }),
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", slug: "dev", type: STATE.envType }),
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));

vi.mock("~/components/alerts/hasLegacyAlerts.server", () => ({
  hasLegacyAlerts: async () => ({ hasLegacyAlerts: true, hasMigratableLegacyAlerts: false }),
}));

vi.mock("~/presenters/v3/AlertsListPresenter.server", () => ({
  AlertsListPresenter: class {
    async call() {
      return { rows: [], page: 1, totalPages: 1, truncated: false };
    }
  },
}));

vi.mock("~/presenters/v3/AlertChannelListPresenter.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AlertChannelListPresenter: class {
    async call() {
      STATE.passedGate = true;
      return { alertChannels: [] };
    }
  },
}));

vi.mock("~/v3/services/alerts/previewSeries.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPreviewSeries: async () => {
    STATE.passedGate = true;
    return { status: 200, body: { series: [] } };
  },
}));

vi.mock("~/models/message.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  redirectWithSuccessMessage: async (path: string) =>
    new Response(null, { status: 302, headers: { Location: path } }),
}));

vi.mock("~/presenters/v3/NewAlertChannelPresenter.server", () => ({
  NewAlertChannelPresenter: class {
    async call() {
      return { slack: { status: "NOT_CONFIGURED" } };
    }
  },
}));

vi.mock("~/v3/services/alerts/createAlertChannel.server", () => ({
  CreateAlertChannelService: class {
    async call(_ref: string, _userId: string, options: { name: string }) {
      STATE.created = options;
      return { name: options.name };
    }
  },
}));

vi.mock("~/v3/canUseAlertsList.server", async () => {
  const { json, redirect } = await import("@remix-run/server-runtime");
  return {
    canUseAlertsList: async () => {
      STATE.passedGate = true;
      return STATE.enabled;
    },
    canUseAlertsListForSlug: async () => STATE.enabled,
    requireAlertsEnabledOrRedirect: async (
      _userId: string,
      p: { organizationSlug: string; projectParam: string; envParam: string }
    ) => {
      if (!STATE.enabled) {
        throw redirect(
          `/orgs/${p.organizationSlug}/projects/${p.projectParam}/env/${p.envParam}/alerts`
        );
      }
    },
    requireAlertsEnabledOrForbid: async () => {
      if (!STATE.enabled) throw json({ error: "Alerts not enabled" }, { status: 403 });
    },
  };
});

vi.mock("~/v3/featureFlags.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  makeFlag: () => async (opts: { defaultValue: unknown }) => opts.defaultValue,
}));

const P = "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam";
const params = { organizationSlug: "o", projectParam: "p", envParam: "dev", channelId: "c" };
const request = (method = "GET") => new Request("http://localhost/x", { method });

async function thrown(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e as Response;
  }
  return undefined;
}

type Mod = { loader?: (a: never) => Promise<unknown>; action?: (a: never) => Promise<unknown> };
const mods: Record<string, Mod> = {};

beforeAll(async () => {
  mods.channels = await import(`~/routes/${P}.alerts.channels/route`);
  mods.legacy = await import(`~/routes/${P}.alerts_.legacy/route`);
  mods.new = await import(`~/routes/${P}.alerts.new/route`);
  mods.slack = await import(`~/routes/${P}.alerts.new.connect-to-slack`);
  mods.preview =
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.preview-series");
}, 120_000);

beforeEach(() => {
  STATE.enabled = false;
  STATE.denyAlertsRead = false;
  STATE.denyAlertsWrite = false;
  STATE.denyProduction = false;
  STATE.denyProductionWrites = false;
  STATE.created = undefined;
  STATE.envType = "DEVELOPMENT";
  STATE.passedGate = false;
});

const REDIRECTING: [string, "loader" | "action"][] = [
  ["channels", "loader"],
  ["channels", "action"],
  ["legacy", "loader"],
  ["legacy", "action"],
];

describe("new alerts surfaces when alertsEnabled is off", () => {
  it.each(REDIRECTING)("%s %s redirects to the old alerts page", async (name, kind) => {
    const res = await thrown(() =>
      mods[name][kind]!({ request: request("POST"), params, context: {} } as never)
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get("Location")).toBe("/orgs/o/projects/p/env/dev/alerts");
  });

  it("preview-series responds 403", async () => {
    const res = await thrown(() => mods.preview.loader!({ request: request(), params } as never));
    expect(res?.status).toBe(403);
  });
});

describe("admin preview when ALERTS_ENABLED is unset", () => {
  it("the real gate redirects an admin to the old alerts page", async () => {
    const real = await vi.importActual<typeof AlertsGate>("~/v3/canUseAlertsList.server");
    const res = await thrown(() => real.requireAlertsEnabledOrRedirect("user_1", params));
    expect(res?.status).toBe(302);
    expect(await real.canUseAlertsList({ orgFeatureFlags: {}, user: { admin: true } })).toBe(false);
  });
});

describe("preview-series authorization", () => {
  it("responds 403 to a member denied read:alerts", async () => {
    STATE.enabled = true;
    STATE.denyAlertsRead = true;
    const res = await thrown(() => mods.preview.loader!({ request: request(), params } as never));
    expect(res?.status).toBe(403);
  });
});

describe("loaders for an environment the role is denied", () => {
  beforeAll(async () => {
    mods.list = await import(`~/routes/${P}.alerts/route`);
    mods.detail = await import(`~/routes/${P}.alerts_.$alertId/route`);
  }, 240_000);

  const GATED: [string, string][] = [
    ["detail", "http://localhost/x"],
    ["list", "http://localhost/x"],
    ["legacy", "http://localhost/x"],
    ["preview", "http://localhost/x?capabilityKey=k&scopeType=all"],
  ];

  it.each(GATED)("%s responds 403 for PRODUCTION", async (name, url) => {
    STATE.enabled = true;
    STATE.denyProduction = true;
    STATE.envType = "PRODUCTION";
    const res = await thrown(() =>
      mods[name].loader!({
        request: new Request(url),
        params: { ...params, alertId: "a" },
      } as never)
    );
    expect(res?.status).toBe(403);
    expect(STATE.passedGate).toBe(false);
  });

  it.each(GATED)("%s proceeds past the gate for DEVELOPMENT", async (name, url) => {
    STATE.enabled = true;
    STATE.denyProduction = true;
    await thrown(() =>
      mods[name].loader!({
        request: new Request(url),
        params: { ...params, alertId: "a" },
      } as never)
    );
    expect(STATE.passedGate).toBe(true);
  });
});

describe("alerts list write and delete gate", () => {
  beforeAll(async () => {
    mods.list ??= await import(`~/routes/${P}.alerts/route`);
  }, 240_000);

  const listData = async (envType: string) => {
    STATE.enabled = true;
    STATE.denyProductionWrites = true;
    STATE.envType = envType;
    const res = (await mods.list.loader!({
      request: new Request("http://localhost/x"),
      params,
      context: {},
    } as never)) as { data?: unknown };
    return (res.data ?? res) as { canWrite: boolean; canDelete: boolean };
  };

  it("checks write and delete for the environment type", async () => {
    expect(await listData("PRODUCTION")).toMatchObject({ canWrite: false, canDelete: false });
    expect(await listData("DEVELOPMENT")).toMatchObject({ canWrite: true, canDelete: true });
  });
});

describe("keeps legacy channel creation reachable", () => {
  it("alerts.new loader responds 200", async () => {
    const res = (await mods.new.loader!({ request: request(), params } as never)) as Response;
    expect(res.status).toBe(200);
  });

  it("alerts.new action creates a channel with the submitted types", async () => {
    const body = new FormData();
    body.append("type", "EMAIL");
    body.append("channelValue", "ops@example.com");
    body.append("alertTypes", "TASK_RUN");
    body.append("alertTypes", "DEPLOYMENT_FAILURE");
    body.append("environmentTypes", "PRODUCTION");
    const res = (await mods.new.action!({
      request: new Request("http://localhost/x", { method: "POST", body }),
      params,
    } as never)) as Response;

    expect(res.headers.get("Location")).toBe("/orgs/o/projects/p/env/dev/alerts");
    expect(STATE.created).toEqual({
      name: "Email to ops@example.com",
      alertTypes: ["TASK_RUN", "DEPLOYMENT_FAILURE"],
      environmentTypes: ["PRODUCTION"],
      channel: { type: "EMAIL", email: "ops@example.com" },
    });
  });

  it("alerts.new action responds 403 and creates nothing for a member denied write:alerts", async () => {
    STATE.denyAlertsWrite = true;
    const body = new FormData();
    body.append("type", "EMAIL");
    body.append("channelValue", "ops@example.com");
    const res = await thrown(() =>
      mods.new.action!({
        request: new Request("http://localhost/x", { method: "POST", body }),
        params,
      } as never)
    );
    expect(res?.status).toBe(403);
    expect(STATE.created).toBeUndefined();
  });

  it.each([
    ["PRODUCTION", 403],
    ["STAGING", 302],
  ])(
    "alerts.new legacy action for %s channels by a role denied PRODUCTION responds %i",
    async (environmentType, status) => {
      STATE.denyProduction = true;
      const body = new FormData();
      body.append("type", "EMAIL");
      body.append("channelValue", "ops@example.com");
      body.append("alertTypes", "TASK_RUN");
      body.append("environmentTypes", environmentType);
      const res = await mods.new.action!({
        request: new Request("http://localhost/x", { method: "POST", body }),
        params,
      } as never).then(
        (r) => r as Response,
        (e) => e as Response
      );
      expect(res.status).toBe(status);
      expect(STATE.created !== undefined).toBe(status === 302);
    }
  );

  it.each([
    [true, 403],
    [false, 302],
  ])(
    "alerts.new action creating an all-environment channel, PRODUCTION denied: %s, responds %i",
    async (denyProduction, status) => {
      STATE.enabled = true;
      STATE.denyProduction = denyProduction;
      const body = new FormData();
      body.append("type", "EMAIL");
      body.append("channelValue", "ops@example.com");
      const res = await mods.new.action!({
        request: new Request("http://localhost/x", { method: "POST", body }),
        params,
      } as never).then(
        (r) => r as Response,
        (e) => e as Response
      );
      expect(res.status).toBe(status);
      expect(STATE.created !== undefined).toBe(status === 302);
    }
  );

  it("alerts.new loader responds 403 for a member denied write:alerts", async () => {
    STATE.denyAlertsWrite = true;
    const res = await thrown(() => mods.new.loader!({ request: request(), params } as never));
    expect(res?.status).toBe(403);
  });

  it("connect-to-slack does not bounce to the alerts page", async () => {
    const res = await mods.slack.loader!({ request: request(), params } as never);
    expect((res as Response).headers.get("Location")).toBe(
      "/orgs/o/projects/p/env/dev/alerts/new?option=slack"
    );
  });
});
