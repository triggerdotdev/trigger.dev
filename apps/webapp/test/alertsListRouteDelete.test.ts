import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const AUTH = vi.hoisted(() => ({ canWrite: true, canDelete: true }));
const performed = vi.hoisted(() => ({ calls: [] as unknown[] }));
const canCalls = vi.hoisted(() => [] as unknown[][]);

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
        can: (action: string, resource: unknown) => {
          canCalls.push([action, resource]);
          return action === "write" ? AUTH.canWrite : action === "delete" ? AUTH.canDelete : true;
        },
      },
    }),
  },
}));

vi.mock("~/v3/canUseAlertsList.server", () => ({ canUseAlertsList: async () => true }));

vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));

vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async () => new Response(null, { status: 302 }),
}));

vi.mock("~/v3/services/alerts/alertActions.server", () => ({
  AlertActionNotAllowedError: class extends Error {},
  AlertNotFoundError: class extends Error {},
  performAlertAction: async (_db: unknown, args: unknown) => {
    performed.calls.push(args);
  },
}));

function deleteRequest() {
  const body = new FormData();
  body.set("action", "delete");
  body.set("id", "alert_1");
  return new Request("http://localhost/orgs/o/projects/p/env/dev/alerts", {
    method: "POST",
    body,
  });
}

const params = { organizationSlug: "o", projectParam: "p", envParam: "dev" };

let action: (args: never) => Promise<unknown>;

beforeAll(async () => {
  const route =
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route");
  action = route.action as unknown as typeof action;
}, 120_000);

function runDelete() {
  return action({ request: deleteRequest(), params, context: {} } as never);
}

describe("alerts list delete", () => {
  beforeEach(() => {
    performed.calls = [];
    canCalls.length = 0;
    AUTH.canWrite = true;
    AUTH.canDelete = true;
  });

  it("refuses a write-only role with 403", async () => {
    AUTH.canDelete = false;
    const error = await runDelete().then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(403);
    expect(performed.calls).toHaveLength(0);
  });

  it("deletes with delete:alerts", async () => {
    await runDelete();
    expect(performed.calls).toHaveLength(1);
  });

  it("checks write and delete for the environment type", async () => {
    await runDelete();
    expect(canCalls).toEqual([
      ["write", { type: "alerts", envType: "DEVELOPMENT" }],
      ["delete", { type: "alerts", envType: "DEVELOPMENT" }],
    ]);
  });
});
