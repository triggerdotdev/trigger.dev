import { describe, expect, it, vi } from "vitest";
import { isLegacyAlertChannel } from "~/components/alerts/legacyAlertChannels";

vi.setConfig({ testTimeout: 30_000 });

const AUTH = vi.hoisted(() => ({
  userId: "user_channels",
  canRead: true,
  canWrite: true,
  denyProduction: false,
}));
const builder = vi.hoisted(() => ({ options: [] as any[] }));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (options: unknown, handler: any) => {
    builder.options.push(options);
    return (args: any) =>
      handler({
        ...args,
        user: { id: AUTH.userId },
        ability: {
          can: (action: string, resource?: { envType?: string }) =>
            !(AUTH.denyProduction && resource?.envType === "PRODUCTION") &&
            (action === "write" ? AUTH.canWrite : AUTH.canRead),
        },
      });
  };
  return { dashboardLoader: wrap, dashboardAction: wrap };
});

vi.mock("~/v3/canUseAlertsList.server", () => ({
  canUseAlertsList: async () => true,
}));

vi.mock("~/services/platform.v3.server", () => ({
  getLimit: async () => 2,
}));

vi.mock("~/env.server", () => ({
  env: { ALERT_FROM_EMAIL: "alerts@example.com", ALERT_RESEND_API_KEY: "key" },
}));

vi.mock("~/presenters/v3/NewAlertChannelPresenter.server", () => ({
  NewAlertChannelPresenter: class {
    async call() {
      return { slack: { status: "NOT_CONFIGURED" } };
    }
  },
}));

const created = vi.hoisted(() => ({ options: undefined as any }));
vi.mock("~/v3/services/alerts/createAlertChannel.server", () => ({
  CreateAlertChannelService: class {
    async call(_ref: string, _userId: string, options: any) {
      created.options = options;
      return {
        id: "ch_new",
        name: options.name,
        type: options.channel.type,
        properties: { url: options.channel.url, secret: "whsec_secret" },
      };
    }
  },
}));

type Row = { id: string; orgId: string; userId: string };
const projectStore = vi.hoisted(() => ({
  replica: [] as Row[],
  primary: [] as Row[],
  channels: [] as {
    id: string;
    name: string;
    type: string;
    projectId: string;
    alertTypes?: string[];
    environmentTypes?: string[];
  }[],
  environments: [
    { id: "env_own", projectId: "proj_own", type: "PRODUCTION" },
    { id: "env_foreign", projectId: "proj_foreign", type: "PRODUCTION" },
    { id: "env_dev", projectId: "proj_own", type: "DEVELOPMENT" },
  ],
}));

vi.mock("~/db.server", () => {
  const client = (rows: () => Row[]) => {
    const findFirst = vi.fn(async ({ where }: any) => {
      const match = rows().find(
        (r) =>
          r.id === where.id &&
          (!where.organization || r.userId === where.organization.members.some.userId)
      );
      if (!match) return null;
      return {
        id: match.id,
        externalRef: `ref_${match.id}`,
        organizationId: match.orgId,
        organization: { featureFlags: {} },
      };
    });
    const findMany = vi.fn(async ({ where }: any) =>
      projectStore.channels.filter(
        (c) =>
          c.projectId === where.projectId &&
          where.enabled &&
          (!where.environmentTypes || c.environmentTypes?.includes(where.environmentTypes.has)) &&
          !where.NOT?.alertTypes.hasSome.some((t: string) => c.alertTypes?.includes(t))
      )
    );
    const count = vi.fn(
      async ({ where }: any) =>
        projectStore.channels.filter((c) => c.projectId === where.projectId).length
    );
    const findEnvironment = vi.fn(
      async ({ where }: any) =>
        projectStore.environments.find(
          (e) =>
            e.id === where.id && (where.projectId === undefined || e.projectId === where.projectId)
        ) ?? null
    );
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "project") return { findFirst };
          if (prop === "projectAlertChannel") return { findMany, count };
          if (prop === "runtimeEnvironment") return { findFirst: findEnvironment };
          return undefined;
        },
      }
    );
  };
  return {
    prisma: client(() => projectStore.primary),
    $replica: client(() => projectStore.replica),
  };
});

const OWN: Row = { id: "proj_own", orgId: "org_1", userId: "user_channels" };
const FOREIGN: Row = { id: "proj_foreign", orgId: "org_2", userId: "user_other" };

function own(rows: { replica?: Row[]; primary?: Row[] } = {}) {
  projectStore.replica = rows.replica ?? [OWN, FOREIGN];
  projectStore.primary = rows.primary ?? [OWN, FOREIGN];
}

function get(query: string) {
  return new Request(`http://localhost/resources/alerts/channels?${query}`);
}

function post(query: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request(`http://localhost/resources/alerts/channels?${query}`, {
    method: "POST",
    body,
  });
}

async function route() {
  const mod = await import("~/routes/resources.alerts.channels");
  return { ...mod, loaderOptions: builder.options[0], actionOptions: builder.options[1] };
}

describe("resources.alerts.channels authorization", () => {
  it("checks read in the loader handler and write/alerts on the action", async () => {
    const { loaderOptions, actionOptions } = await route();
    expect(loaderOptions.authorization).toBeUndefined();
    expect(actionOptions.authorization).toEqual({
      action: "write",
      resource: { type: "alerts" },
    });
  });

  it("scopes to the project, falling back to the primary on replica lag", async () => {
    const { loaderOptions, actionOptions } = await route();
    expect(actionOptions.context).toBe(loaderOptions.context);
    own({ replica: [] });
    expect(await loaderOptions.context(undefined, get("projectId=proj_own"))).toEqual({
      organizationId: "org_1",
      projectId: "proj_own",
    });
    expect(await loaderOptions.context(undefined, get("projectId=proj_missing"))).toEqual({});
    expect(await loaderOptions.context(undefined, get(""))).toEqual({});
  });
});

describe("resources.alerts.channels loader", () => {
  it("returns 404 for a foreign project", async () => {
    own();
    const { loader } = await route();
    const thrown = await loader({
      request: get("projectId=proj_foreign"),
      params: {},
      context: {},
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("filters channels by the environment's type", async () => {
    own();
    projectStore.channels = [
      {
        id: "ch_prod",
        name: "P",
        type: "EMAIL",
        projectId: "proj_own",
        environmentTypes: ["PRODUCTION"],
      },
      {
        id: "ch_dev",
        name: "D",
        type: "EMAIL",
        projectId: "proj_own",
        environmentTypes: ["DEVELOPMENT"],
      },
    ];
    const { loader } = await route();
    const resp = await loader({
      request: get("projectId=proj_own&environmentId=env_own"),
      params: {},
      context: {},
    });
    const data: any = await resp.json();
    expect(data.channels.map((c: { id: string }) => c.id)).toEqual(["ch_prod"]);
  });

  it("returns no channels for another project's environment", async () => {
    own();
    projectStore.channels = [
      {
        id: "ch_prod",
        name: "P",
        type: "EMAIL",
        projectId: "proj_own",
        environmentTypes: ["PRODUCTION"],
      },
    ];
    const { loader } = await route();
    const resp = await loader({
      request: get("projectId=proj_own&environmentId=env_foreign"),
      params: {},
      context: {},
    });
    expect(await resp.json()).toEqual({ channels: [], canWrite: false });
  });

  it("returns channels, write access and limits for an owned project", async () => {
    own();
    projectStore.channels = [{ id: "ch_1", name: "Slack", type: "SLACK", projectId: "proj_own" }];
    AUTH.canWrite = false;
    const { loader } = await route();
    const resp = await loader({ request: get("projectId=proj_own"), params: {}, context: {} });
    const data: any = await resp.json();
    expect(data.channels).toHaveLength(1);
    expect(data.channels[0].name).toBe("Slack");
    expect(data.canWrite).toBe(false);
    expect(data.limits).toEqual({ used: 1, limit: 2 });
    expect(data.form).toBeUndefined();
    AUTH.canWrite = true;
  });

  it("lists channels that carry legacy alert types", async () => {
    own();
    projectStore.channels = [
      { id: "ch_new", name: "New", type: "EMAIL", projectId: "proj_own", alertTypes: [] },
      { id: "ch_old", name: "Old", type: "EMAIL", projectId: "proj_own", alertTypes: ["TASK_RUN"] },
    ];
    const { loader } = await route();
    const ids = async (query: string) =>
      (
        (await (await loader({ request: get(query), params: {}, context: {} })).json()) as any
      ).channels.map((c: { id: string }) => c.id);
    expect(await ids("projectId=proj_own")).toEqual(["ch_new", "ch_old"]);
    projectStore.channels = [{ id: "ch_1", name: "Slack", type: "SLACK", projectId: "proj_own" }];
  });

  it("returns an empty list without read access", async () => {
    own();
    AUTH.canRead = false;
    const { loader } = await route();
    const resp = await loader({ request: get("projectId=proj_own"), params: {}, context: {} });
    expect(await resp.json()).toEqual({ channels: [], canWrite: false });
    AUTH.canRead = true;
  });

  it.each([
    ["env_own", 403, []],
    ["env_dev", 200, ["ch_dev"]],
  ])("for a role denied PRODUCTION, %s responds %i", async (environmentId, status, channelIds) => {
    own();
    projectStore.channels = [
      {
        id: "ch_dev",
        name: "D",
        type: "EMAIL",
        projectId: "proj_own",
        environmentTypes: ["DEVELOPMENT", "PRODUCTION"],
      },
    ];
    AUTH.denyProduction = true;
    const { loader } = await route();
    const resp = await loader({
      request: get(`projectId=proj_own&environmentId=${environmentId}`),
      params: {},
      context: {},
    });
    AUTH.denyProduction = false;
    expect(resp.status).toBe(status);
    const data: any = await resp.json();
    expect(data.channels.map((c: { id: string }) => c.id)).toEqual(channelIds);
  });

  it("finds a project only on the primary", async () => {
    own({ replica: [] });
    const { loader } = await route();
    const resp = await loader({ request: get("projectId=proj_own"), params: {}, context: {} });
    expect(((await resp.json()) as any).limits).toEqual({ used: 1, limit: 2 });
  });

  it("adds the channel form state on request", async () => {
    own();
    const { loader } = await route();
    const resp = await loader({
      request: get("projectId=proj_own&form=1"),
      params: {},
      context: {},
    });
    const data: any = await resp.json();
    expect(data.form).toEqual({ slack: { status: "NOT_CONFIGURED" }, emailAlertsEnabled: true });
  });
});

describe("resources.alerts.channels action", () => {
  it("creates an email channel and returns it as JSON", async () => {
    own();
    projectStore.channels = [];
    const { action } = await route();
    const resp = await action({
      request: post("projectId=proj_own", { type: "EMAIL", channelValue: "ops@example.com" }),
      params: {},
      context: {},
    });
    expect(await resp.json()).toEqual({
      channel: { id: "ch_new", name: "Email to ops@example.com", type: "EMAIL" },
    });
    expect(created.options.alertTypes).toEqual([]);
  });

  it("creates a channel that does not count as a legacy alert", async () => {
    own();
    projectStore.channels = [];
    const { action } = await route();
    await action({
      request: post("projectId=proj_own", { type: "EMAIL", channelValue: "ops@example.com" }),
      params: {},
      context: {},
    });
    expect(isLegacyAlertChannel(created.options.alertTypes)).toBe(false);
  });

  it("creates a webhook channel without returning its secret", async () => {
    own();
    projectStore.channels = [];
    const { action } = await route();
    const resp = await action({
      request: post("projectId=proj_own", {
        type: "WEBHOOK",
        channelValue: "https://93.184.215.14/hook",
      }),
      params: {},
      context: {},
    });
    const data: any = await resp.json();
    expect(data.channel).toEqual({
      id: "ch_new",
      name: "Webhook to 93.184.215.14",
      type: "WEBHOOK",
    });
    expect(JSON.stringify(data)).not.toContain("secret");
    expect(JSON.stringify(data)).not.toContain("properties");
  });

  it("rejects an unsafe webhook URL with a field error", async () => {
    own();
    projectStore.channels = [];
    created.options = undefined;
    const { action } = await route();
    const resp = await action({
      request: post("projectId=proj_own", {
        type: "WEBHOOK",
        channelValue: "http://169.254.169.254/latest",
      }),
      params: {},
      context: {},
    });
    const data: any = await resp.json();
    expect(data.channel).toBeUndefined();
    expect(data.error.channelValue).toBeDefined();
    expect(created.options).toBeUndefined();
  });

  it("refuses to create for a role denied PRODUCTION", async () => {
    own();
    projectStore.channels = [];
    created.options = undefined;
    AUTH.denyProduction = true;
    const { action } = await route();
    const status = await Promise.resolve(
      action({
        request: post("projectId=proj_own", { type: "EMAIL", channelValue: "ops@example.com" }),
        params: {},
        context: {},
      })
    ).then(
      (r: Response) => r.status,
      (e: Response) => e.status
    );
    AUTH.denyProduction = false;
    expect(status).toBe(403);
    expect(created.options).toBeUndefined();
  });

  it("refuses to create past the channel limit", async () => {
    own();
    projectStore.channels = [
      { id: "a", name: "a", type: "EMAIL", projectId: "proj_own" },
      { id: "b", name: "b", type: "EMAIL", projectId: "proj_own" },
    ];
    created.options = undefined;
    const { action } = await route();
    const resp = await action({
      request: post("projectId=proj_own", { type: "EMAIL", channelValue: "ops@example.com" }),
      params: {},
      context: {},
    });
    const data: any = await resp.json();
    expect(data.channel).toBeUndefined();
    expect(created.options).toBeUndefined();
  });
});
