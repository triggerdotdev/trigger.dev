import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  envType: "DEVELOPMENT",
  onlyDeleteDenied: false,
  existing: [] as {
    id: string;
    type: string;
    alertTypes: string[];
    environmentTypes: string[];
    deduplicationKey?: string;
  }[],
  created: [] as unknown[],
  deleted: [] as string[],
  listed: false,
  afterLookup: undefined as (() => void) | undefined,
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => {
  const wrap = (options: any, handler: (args: unknown) => unknown) => async (args: any) => {
    const ability = {
      can: (action: string, resource: { type: string; envType?: string }) =>
        !(
          resource.type === "alerts" &&
          resource.envType === "PRODUCTION" &&
          (!STATE.onlyDeleteDenied || action === "delete")
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

vi.mock("~/services/session.server", () => ({ requireUserId: async () => "user_1" }));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({
    id: "proj_1",
    externalRef: "proj_ref",
    organizationId: "org_1",
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: STATE.envType }),
}));
vi.mock("~/presenters/v3/ErrorAlertChannelPresenter.server", () => ({
  ErrorAlertChannelPresenter: class {
    async call() {
      return {
        emails: [{ id: "c1", email: "ops@example.com" }],
        webhooks: [{ id: "c2", url: "https://secret.example.com/hook" }],
        slackChannel: null,
        slack: { status: "NOT_CONFIGURED" },
        emailAlertsEnabled: true,
      };
    }
  },
}));
vi.mock("~/env.server", () => ({ env: {} }));
vi.mock("~/db.server", () => ({
  $replica: {},
  prisma: {
    projectAlertChannel: {
      findMany: async ({ where }: any) => {
        const rows = structuredClone(
          STATE.existing.filter((c) =>
            where.deduplicationKey
              ? c.deduplicationKey?.startsWith(where.deduplicationKey.startsWith) &&
                c.deduplicationKey.endsWith(where.deduplicationKey.endsWith)
              : c.alertTypes.includes("ERROR_GROUP") &&
                c.environmentTypes.includes(where.environmentTypes.has)
          )
        );
        if (where.deduplicationKey) STATE.afterLookup?.();
        return rows;
      },
      findFirst: async ({ where }: any) => STATE.existing.find((c) => c.id === where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        STATE.deleted.push(where.id);
      },
      deleteMany: async ({ where }: any) => {
        const row = STATE.existing.find(
          (c) =>
            c.id === where.id &&
            (!where.environmentTypes ||
              JSON.stringify(c.environmentTypes) === JSON.stringify(where.environmentTypes.equals))
        );
        if (!row) return { count: 0 };
        STATE.deleted.push(row.id);
        return { count: 1 };
      },
    },
  },
}));
vi.mock(
  "~/v3/services/baseService.server",
  async () => await import("~/v3/services/common.server")
);
vi.mock("~/v3/services/alerts/createAlertChannel.server", () => {
  class AlertChannelChangedError extends Error {}
  return {
    AlertChannelChangedError,
    CreateAlertChannelService: class {
      async call(_ref: string, _userId: string, options: any) {
        const row = STATE.existing.find((c) => c.deduplicationKey === options.deduplicationKey);
        if (
          options.authorizedChannel !== undefined &&
          JSON.stringify(options.authorizedChannel?.environmentTypes) !==
            JSON.stringify(row?.environmentTypes)
        ) {
          throw new AlertChannelChangedError();
        }
        STATE.created.push(options);
        return { id: `c${STATE.created.length}` };
      }
    },
  };
});
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/presenters/v3/ApiErrorGroupPresenter.server", () => ({}));
vi.mock("~/presenters/v3/ErrorsListPresenter.server", () => ({
  ErrorsListPresenter: class {
    async call() {
      STATE.listed = true;
      return { errorGroups: [] };
    }
  },
}));

const { action, loader: errorsLoader } =
  await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.errors/route");
const { loader } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.error-groups");

const params = { organizationSlug: "o", projectParam: "p", envParam: "dev" };

function postWebhook() {
  const body = new FormData();
  body.append("webhooks", "https://example.com/hook");
  return action({
    request: new Request("http://localhost/errors", { method: "POST", body }),
    params,
    context: {},
  } as never);
}

const getGroups = () =>
  loader({
    request: new Request("http://localhost/error-groups"),
    params,
    context: {},
  } as never);

async function thrown(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e as Response;
  }
  return undefined;
}

beforeEach(() => {
  STATE.envType = "DEVELOPMENT";
  STATE.onlyDeleteDenied = false;
  STATE.existing = [];
  STATE.created = [];
  STATE.deleted = [];
  STATE.listed = false;
  STATE.afterLookup = undefined;
});

describe("errors page channel action", () => {
  it("rejects a PRODUCTION-denied user before creating or deleting channels", async () => {
    STATE.envType = "PRODUCTION";
    STATE.existing = [
      { id: "old", type: "WEBHOOK", alertTypes: ["ERROR_GROUP"], environmentTypes: ["PRODUCTION"] },
    ];
    const res = await thrown(postWebhook);
    expect(res?.status).toBe(403);
    expect(STATE.created).toEqual([]);
    expect(STATE.deleted).toEqual([]);
  });

  it("rejects when an existing channel spans a denied environment", async () => {
    STATE.existing = [
      {
        id: "old",
        type: "WEBHOOK",
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["DEVELOPMENT", "PRODUCTION"],
      },
    ];
    const res = await thrown(postWebhook);
    expect(res?.status).toBe(403);
    expect(STATE.created).toEqual([]);
    expect(STATE.deleted).toEqual([]);
  });

  it("rejects deleting a stale channel that spans a delete-denied environment", async () => {
    STATE.onlyDeleteDenied = true;
    STATE.existing = [
      {
        id: "old",
        type: "WEBHOOK",
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["DEVELOPMENT", "PRODUCTION"],
      },
    ];
    const res = await thrown(postWebhook);
    expect(res?.status).toBe(403);
    expect(STATE.created).toEqual([]);
    expect(STATE.deleted).toEqual([]);
  });

  it("lets a delete-denied writer re-submit a channel that spans PRODUCTION", async () => {
    STATE.onlyDeleteDenied = true;
    STATE.existing = [
      {
        id: "old",
        type: "WEBHOOK",
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["DEVELOPMENT", "PRODUCTION"],
        deduplicationKey: "error-webhook:https://example.com/hook:DEVELOPMENT",
      },
    ];
    const res = (await postWebhook()) as Response;
    expect(res.status).toBe(200);
    expect(STATE.created).toHaveLength(1);
    expect(STATE.deleted).toEqual([]);
  });

  it("rejects overwriting a same-key channel in a write-denied environment", async () => {
    STATE.existing = [
      {
        id: "other",
        type: "WEBHOOK",
        alertTypes: ["DEPLOYMENT_FAILURE"],
        environmentTypes: ["PRODUCTION"],
        deduplicationKey: "error-webhook:https://example.com/hook:DEVELOPMENT",
      },
    ];
    const res = await thrown(postWebhook);
    expect(res?.status).toBe(403);
    expect(STATE.created).toEqual([]);
  });

  it("does not overwrite a matched channel widened to PRODUCTION after the check", async () => {
    STATE.existing = [
      {
        id: "same",
        type: "WEBHOOK",
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["DEVELOPMENT"],
        deduplicationKey: "error-webhook:https://example.com/hook:DEVELOPMENT",
      },
    ];
    STATE.afterLookup = () => {
      STATE.existing[0]!.environmentTypes = ["DEVELOPMENT", "PRODUCTION"];
    };
    const res = (await postWebhook()) as Response;
    expect(res.status).toBe(409);
    expect(STATE.created).toEqual([]);
  });

  it("does not delete a stale channel widened to PRODUCTION after the check", async () => {
    STATE.existing = [
      {
        id: "old",
        type: "WEBHOOK",
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["DEVELOPMENT"],
        deduplicationKey: "error-webhook:https://old.example.com:DEVELOPMENT",
      },
    ];
    STATE.afterLookup = () => {
      STATE.existing[0]!.environmentTypes = ["DEVELOPMENT", "PRODUCTION"];
    };
    const res = await thrown(postWebhook);
    expect(res?.status).toBe(403);
    expect(STATE.deleted).toEqual([]);
  });

  it("lets a delete-denied writer create when nothing is stale", async () => {
    STATE.onlyDeleteDenied = true;
    const res = (await postWebhook()) as Response;
    expect(res.status).toBe(200);
    expect(STATE.created).toHaveLength(1);
  });

  it("proceeds in DEVELOPMENT", async () => {
    const res = (await postWebhook()) as Response;
    expect(res.status).toBe(200);
    expect(STATE.created).toHaveLength(1);
  });
});

describe("errors page loader", () => {
  const load = async () =>
    (await (
      (await errorsLoader({
        request: new Request("http://localhost/errors"),
        params,
        context: {},
      } as never)) as Response
    ).text()) as string;

  it("omits channel configuration for a PRODUCTION-denied reader", async () => {
    STATE.envType = "PRODUCTION";
    const body = await load();
    expect(body).not.toContain("ops@example.com");
    expect(body).not.toContain("secret.example.com");
  });

  it("omits it when a channel spans a denied environment", async () => {
    STATE.existing = [
      {
        id: "c2",
        type: "WEBHOOK",
        alertTypes: ["ERROR_GROUP"],
        environmentTypes: ["DEVELOPMENT", "PRODUCTION"],
      },
    ];
    const body = await load();
    expect(body).not.toContain("secret.example.com");
  });

  it("includes channel configuration for an allowed reader", async () => {
    const body = await load();
    expect(body).toContain("ops@example.com");
    expect(body).toContain("secret.example.com");
  });
});

describe("alerts error-groups loader", () => {
  it("rejects a PRODUCTION-denied user before listing error groups", async () => {
    STATE.envType = "PRODUCTION";
    const res = (await getGroups()) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ groups: [] });
    expect(STATE.listed).toBe(false);
  });

  it("lists error groups in DEVELOPMENT", async () => {
    const res = (await getGroups()) as Response;
    expect(res.status).toBe(200);
    expect(STATE.listed).toBe(true);
  });
});
