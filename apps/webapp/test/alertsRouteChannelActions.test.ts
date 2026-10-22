import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  channels: [] as { id: string; projectId: string; environmentTypes: string[]; enabled: boolean }[],
  afterRead: undefined as (() => void) | undefined,
}));

vi.mock("~/services/session.server", () => ({ requireUserId: async () => "user_1" }));

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

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      ability: {
        can: (action: string, resource: { type: string; envType?: string }) =>
          ["write", "delete"].includes(action) &&
          resource.type === "alerts" &&
          resource.envType !== "PRODUCTION",
      },
    }),
  },
}));

vi.mock("~/v3/canUseAlertsList.server", () => ({ canUseAlertsList: async () => false }));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async () => new Response(null, { status: 302 }),
}));

vi.mock("~/db.server", () => {
  const matches = (c: (typeof STATE.channels)[number], where: any) =>
    c.id === where.id &&
    c.projectId === where.projectId &&
    (!where.environmentTypes || c.environmentTypes.join() === where.environmentTypes.equals.join());
  return {
    prisma: {
      projectAlertChannel: {
        findFirst: async ({ where }: any) => {
          const channel = STATE.channels.find((c) => matches(c, where));
          const snapshot = channel && {
            ...channel,
            name: "chan",
            alertTypes: [],
            environmentTypes: [...channel.environmentTypes],
          };
          STATE.afterRead?.();
          return snapshot ?? null;
        },
        deleteMany: async ({ where }: any) => {
          const before = STATE.channels.length;
          STATE.channels = STATE.channels.filter((c) => !matches(c, where));
          return { count: before - STATE.channels.length };
        },
        updateMany: async ({ where, data }: any) => {
          const hit = STATE.channels.filter((c) => matches(c, where));
          for (const channel of hit) channel.enabled = data.enabled;
          return { count: hit.length };
        },
      },
    },
    $replica: {},
  };
});

let action: (args: never) => Promise<unknown>;

beforeAll(async () => {
  const route =
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route");
  action = route.action as unknown as typeof action;
}, 120_000);

const params = { organizationSlug: "o", projectParam: "p", envParam: "dev" };

async function run(intent: string, id: string) {
  const body = new FormData();
  body.set("action", intent);
  body.set("id", id);
  const request = new Request("http://localhost/orgs/o/projects/p/env/dev/alerts", {
    method: "POST",
    body,
  });
  return action({ request, params, context: {} } as never).then(
    (r) => (r as Response).status,
    (e) => (e as Response).status
  );
}

describe("alerts page channel actions for a role denied PRODUCTION", () => {
  beforeEach(() => {
    STATE.channels = [
      {
        id: "ch_prod",
        projectId: "proj_1",
        environmentTypes: ["PRODUCTION", "DEVELOPMENT"],
        enabled: false,
      },
      { id: "ch_dev", projectId: "proj_1", environmentTypes: ["DEVELOPMENT"], enabled: false },
    ];
    STATE.afterRead = undefined;
  });

  it.each(["enable", "disable", "delete"])(
    "%s of a channel covering PRODUCTION is 403",
    async (intent) => {
      STATE.channels[0].enabled = intent === "disable";
      expect(await run(intent, "ch_prod")).toBe(403);
      expect(STATE.channels[0]).toMatchObject({ id: "ch_prod", enabled: intent === "disable" });
    }
  );

  it("enables, disables and deletes a DEVELOPMENT channel", async () => {
    expect(await run("enable", "ch_dev")).toBe(302);
    expect(STATE.channels[1].enabled).toBe(true);
    expect(await run("disable", "ch_dev")).toBe(302);
    expect(STATE.channels[1].enabled).toBe(false);
    expect(await run("delete", "ch_dev")).toBe(302);
    expect(STATE.channels.map((c) => c.id)).toEqual(["ch_prod"]);
  });

  it.each(["enable", "disable", "delete"])(
    "%s is 403 when PRODUCTION is added after the authorization read",
    async (intent) => {
      STATE.channels[1].enabled = intent === "disable";
      STATE.afterRead = () => {
        STATE.afterRead = undefined;
        STATE.channels[1].environmentTypes = ["PRODUCTION", "DEVELOPMENT"];
      };
      expect(await run(intent, "ch_dev")).toBe(403);
      expect(STATE.channels[1]).toMatchObject({ id: "ch_dev", enabled: intent === "disable" });
    }
  );
});
