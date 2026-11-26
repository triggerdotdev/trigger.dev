import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  canRead: true,
  organizationCanWrite: true,
  sessionOk: true,
  queries: 0,
}));

vi.mock("~/env.server", () => ({ env: { DEPLOYMENTS_AUTORELOAD_POLL_INTERVAL_MS: 5_000 } }));
vi.mock("~/services/session.server", () => ({ requireUserId: async () => "user_1" }));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async (_request: Request, scope: { projectId?: string }) =>
      STATE.sessionOk
        ? {
            ok: true,
            ability: {
              can: (action: string) =>
                action === "read" ? STATE.canRead : !!scope.projectId || STATE.organizationCanWrite,
            },
          }
        : { ok: false, reason: "unauthorized" },
  },
}));
vi.mock("~/presenters/v3/DeploymentPresenter.server", () => ({
  DeploymentPresenter: class {
    async call() {
      return {
        eventStream: undefined,
        deployment: {
          id: "deployment_1",
          version: "20261119.1",
          status: "FAILED",
          createdAt: new Date("2026-11-19T10:00:00Z"),
          deployedAt: null,
          organizationId: "org_1",
          projectId: "proj_1",
          environment: { id: "env_1" },
          // No worker: the loader needs no ClickHouse or overview read.
          tasks: undefined,
        },
      };
    }
  },
}));
vi.mock("~/db.server", () => {
  const findFirst = async () => {
    STATE.queries++;
    return null;
  };
  return {
    prisma: {},
    $replica: { workerDeploymentPromotion: { findFirst }, workerDeployment: { findFirst } },
  };
});
vi.mock("~/presenters/v3/DeploymentOverviewPresenter.server", () => ({
  DeploymentOverviewPresenter: class {},
}));
vi.mock("~/presenters/v3/NextRunListPresenter.server", () => ({
  NextRunListPresenter: class {},
}));
vi.mock("~/presenters/v3/runColumnsFromRequest.server", () => ({
  getRunColumnsForSelect: () => undefined,
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {},
}));

let loader: (args: { request: Request; params: Record<string, string> }) => Promise<unknown>;

beforeAll(async () => {
  loader = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments_.$deploymentParam/route")
  ).loader as typeof loader;
}, 120_000);

beforeEach(() => {
  STATE.canRead = true;
  STATE.organizationCanWrite = true;
  STATE.sessionOk = true;
});

const load = () =>
  loader({
    request: new Request("http://localhost/orgs/acme/projects/app/env/prod/deployments/abc123"),
    params: {
      organizationSlug: "acme",
      projectParam: "app",
      envParam: "prod",
      deploymentParam: "abc123",
    },
  });

async function status(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as Response).status;
  }
}

describe("deployment page loader", () => {
  it("loads for a role that can read deployments", async () => {
    expect(await status(load())).toBe(200);
  });

  // Catches: promote, rollback and cancel shown to someone their actions will refuse. Those
  // actions authenticate in the organization's scope.
  it("shows the write actions by the organization role, as the actions check it", async () => {
    STATE.organizationCanWrite = false;
    const { data } = (await load()) as { data: { canWriteDeployments: boolean } };
    expect(data.canWriteDeployments).toBe(false);
  });

  it("is a permission-denied 403 for a role that can't read deployments", async () => {
    STATE.canRead = false;
    expect(await status(load())).toBe(403);
  });

  it("is a permission-denied 403 when the session has no role in the organization", async () => {
    STATE.sessionOk = false;
    expect(await status(load())).toBe(403);
  });
});
