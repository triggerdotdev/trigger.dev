import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const STATE = vi.hoisted(() => ({
  canRead: true,
  organizationCanWrite: true,
  projectCanWrite: true,
  sessionOk: true,
  authorization: undefined as unknown,
  authScope: undefined as unknown,
  sessionScopes: [] as unknown[],
}));

vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-secret",
    NODE_ENV: "test",
    DEPLOYMENTS_AUTORELOAD_POLL_INTERVAL_MS: 5_000,
    DEPLOYMENTS_REDEPLOY_WINDOW_DAYS: 30,
  },
}));
vi.mock("~/services/session.server", () => ({ requireUserId: async () => "user_1" }));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async (_request: Request, scope: { projectId?: string }) => {
      STATE.sessionScopes.push(scope);
      const canWrite = scope.projectId ? STATE.projectCanWrite : STATE.organizationCanWrite;
      return STATE.sessionOk
        ? {
            ok: true,
            ability: { can: (action: string) => (action === "read" ? STATE.canRead : canWrite) },
          }
        : { ok: false, reason: "unauthorized" };
    },
  },
}));
// The route builder authenticates the session in `context`'s scope and asks the role for
// `authorization`; this records what the route hands it.
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  // Other routes the list page's components import define actions with it.
  dashboardAction: () => async () => null,
  dashboardLoader:
    (
      options: {
        params: { parse: (params: unknown) => unknown };
        context: (params: unknown) => Promise<unknown>;
        authorization: unknown;
      },
      handler: (args: unknown) => Promise<Response>
    ) =>
    async ({ request, params }: { request: Request; params: unknown }) => {
      const parsed = options.params.parse(params);
      STATE.authorization = options.authorization;
      STATE.authScope = await options.context(parsed);
      return handler({ request, params: parsed, user: { id: "user_1" } });
    },
}));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async (organizationSlug: string, projectSlug: string) => ({
    organizationSlug,
    projectSlug,
  }),
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {}, sqlDatabaseSchema: {} }));
vi.mock("~/models/project.server", () => ({ findProjectBySlug: async () => ({ id: "proj_1" }) }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1" }),
}));
vi.mock("~/presenters/v3/DeploymentListPresenter.server", () => ({
  DeploymentListPresenter: class {
    async call() {
      return {
        deployments: [],
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        environmentType: "PRODUCTION",
      };
    }
  },
}));
vi.mock("~/v3/services/deploymentOnboardingUi.server", () => ({
  resolveDeploymentOnboardingUi: async () => ({}),
}));
vi.mock("~/v3/deploymentBranches.server", () => ({
  listDeploymentBranches: async () => ["main"],
}));

type Loader = (args: {
  request: Request;
  params: Record<string, string>;
  context: object;
}) => Promise<unknown>;

let listLoader: Loader;
let branchesLoader: Loader;

beforeAll(async () => {
  listLoader = (
    await import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments/route")
  ).loader as unknown as Loader;
  branchesLoader = (
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments.branches")
  ).loader as unknown as Loader;
}, 120_000);

beforeEach(() => {
  STATE.canRead = true;
  STATE.organizationCanWrite = true;
  STATE.projectCanWrite = true;
  STATE.sessionOk = true;
  STATE.sessionScopes = [];
});

const params = { organizationSlug: "acme", projectParam: "app", envParam: "prod" };

async function status(loader: Loader, path: string) {
  try {
    await loader({ request: new Request(`http://localhost${path}`), params, context: {} });
    return 200;
  } catch (error) {
    return (error as Response).status;
  }
}

describe("deployments list loader", () => {
  const list = () => status(listLoader, "/orgs/acme/projects/app/env/prod/deployments");

  it("loads for a role that can read deployments", async () => {
    expect(await list()).toBe(200);
  });

  // Catches: read access decided on the organization role alone, which leaves out a role held
  // on this project.
  it("decides read access in the list's own project", async () => {
    await list();
    expect(STATE.sessionScopes).toContainEqual({
      userId: "user_1",
      organizationId: "org_1",
      projectId: "proj_1",
    });
  });

  // Catches: promote, rollback and cancel shown to someone their actions will refuse. Those
  // actions authenticate in the organization's scope.
  it("shows the write actions by the organization role, as the actions check it", async () => {
    STATE.organizationCanWrite = false;
    const response = (await listLoader({
      request: new Request("http://localhost/orgs/acme/projects/app/env/prod/deployments"),
      params,
      context: {},
    })) as Response;

    expect((await response.json()).canWriteDeployments).toBe(false);
  });

  // Catches: the denial turned into the page's generic error.
  it("is a permission-denied 403 for a role that can't read deployments", async () => {
    STATE.canRead = false;
    expect(await list()).toBe(403);
  });

  it("is a permission-denied 403 when the session has no role in the organization", async () => {
    STATE.sessionOk = false;
    expect(await list()).toBe(403);
  });
});

describe("deployment branches loader", () => {
  const branches = () =>
    status(branchesLoader, "/resources/orgs/acme/projects/app/env/prod/deployments/branches");

  it("asks the route builder for read access to deployments in the project's scope", async () => {
    expect(await branches()).toBe(200);
    expect(STATE.authorization).toEqual({ action: "read", resource: { type: "deployments" } });
    expect(STATE.authScope).toEqual({ organizationSlug: "acme", projectSlug: "app" });
  });
});
