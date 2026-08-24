import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The run-commit route answers with a deployment's git metadata — commit message, author, branch,
 * PR title. The deployments list serves the same blob behind `read` on `deployments`, so a
 * credential without that scope must not get it from here either.
 */

const { SESSION_SECRET } = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-run-commit-authorization",
}));

const mocks = vi.hoisted(() => ({
  can: vi.fn<(...args: any[]) => boolean>(),
  resolveRunCommit: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("@internal/tracing", () => ({
  getMeter: () => ({
    createCounter: () => ({ add: vi.fn() }),
    createHistogram: () => ({ record: vi.fn() }),
    createObservableGauge: () => ({ addCallback: vi.fn() }),
  }),
}));
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET, APP_ORIGIN: "https://example.com" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: vi.fn(),
    authenticateUserActor: async () => ({ ok: true, ability: { can: mocks.can } }),
    authenticatePat: async () => ({ ok: true, ability: { can: mocks.can } }),
  },
}));
vi.mock("~/services/personalAccessToken.server", () => ({
  authenticateApiRequestWithPersonalAccessToken: vi.fn(),
  isPersonalAccessToken: () => false,
  // Test tokens carry no source PAT, so the liveness recheck always passes.
  assertSourcePatActive: async () => true,
}));
vi.mock("~/services/organizationAccessToken.server", () => ({
  authenticateApiRequestWithOrganizationAccessToken: vi.fn(),
  isOrganizationAccessToken: () => false,
}));
vi.mock("~/services/realtime/jwtAuth.server", () => ({
  isPublicJWT: () => false,
  validatePublicJwtKey: vi.fn(),
}));
vi.mock("~/models/project.server", () => ({
  findProjectByRef: async (externalRef: string, userId: string) =>
    externalRef === PROJECT.externalRef && userId === USER_ID ? PROJECT : null,
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  authIncludeBase: {},
  authIncludeWithParent: {},
  findEnvironmentByApiKey: vi.fn(),
  findEnvironmentByApiKeyWithResolution: vi.fn(),
  findEnvironmentByPublicApiKey: vi.fn(),
  toAuthenticated: (environment: any) => environment,
}));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {
    user: {
      findUnique: async ({ where }: any) => (where.id === USER_ID ? { id: where.id } : null),
    },
    runtimeEnvironment: {
      findFirst: async ({ where }: any) => (where.slug === ENVIRONMENT.slug ? ENVIRONMENT : null),
    },
    workerDeployment: {
      findFirst: async () => ({
        git: { commitMessage: "fix billing for Acme Corp", commitAuthorName: "Alice" },
        shortCode: "abcd",
        deployedAt: new Date(),
      }),
    },
  },
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  resolveRunCommit: mocks.resolveRunCommit,
}));

import { signUserActorToken } from "@trigger.dev/rbac";
import { loader as commitLoader } from "~/routes/api.v1.projects.$projectRef.$env.runs.$runId.commit";

const ORGANIZATION = { id: "org_1234", slug: "test-org" };
const PROJECT = { id: "proj_1234", externalRef: "proj_ref_1234", slug: "test-project" };
const USER_ID = "usr_member";
const ENVIRONMENT = {
  id: "env_prod",
  slug: "prod",
  type: "PRODUCTION" as const,
  apiKey: "tr_prod_abcdefghijklmnop",
  organizationId: ORGANIZATION.id,
  organization: ORGANIZATION,
  projectId: PROJECT.id,
  project: PROJECT,
};

async function getCommit(): Promise<{ status: number; body: any }> {
  const token = await signUserActorToken(SESSION_SECRET, {
    userId: USER_ID,
    client: "dashboard-agent",
    environmentId: ENVIRONMENT.id,
    cap: ["read:runs"],
  });

  const response = await commitLoader({
    request: new Request(
      `https://example.com/api/v1/projects/${PROJECT.externalRef}/prod/runs/run_1/commit`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
    params: { projectRef: PROJECT.externalRef, env: "prod", runId: "run_1" },
    context: {} as any,
  } as any);
  return { status: response.status, body: await response.json() };
}

describe("reading a run's commit metadata", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.resolveRunCommit.mockReset();
    // The commit resolves fine, so a refusal can only come from the gate.
    mocks.resolveRunCommit.mockResolvedValue({
      version: "20240101.1",
      sha: "abc123",
      dirty: false,
    });
  });

  it("refuses a caller who may not read deployments", async () => {
    mocks.can.mockImplementation((_action, resource) => resource?.type !== "deployments");

    const result = await getCommit();

    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain("Acme Corp");
    expect(mocks.resolveRunCommit).not.toHaveBeenCalled();
  });

  it("answers a caller who may", async () => {
    mocks.can.mockReturnValue(true);

    const result = await getCommit();

    expect(result.status).toBe(200);
    expect(result.body.sha).toBe("abc123");
    expect(result.body.git.commitMessage).toBe("fix billing for Acme Corp");
  });
});
