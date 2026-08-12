import { buildJwtAbility, signUserActorToken } from "@trigger.dev/rbac";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_SECRET = "test-session-secret";
const USER_ID = "usr_1";
const PROJECT_ID = "proj_1";

const PARENT_PREVIEW = {
  id: "env_preview_parent",
  slug: "preview",
  type: "PREVIEW",
  isBranchableEnvironment: true,
  parentEnvironmentId: null,
  branchName: null,
  paused: false,
  projectId: PROJECT_ID,
  organizationId: "org_1",
  archivedAt: null,
};

const BRANCH_CHILD = {
  id: "env_preview_branch",
  slug: "branch-feat-x",
  type: "PREVIEW",
  isBranchableEnvironment: false,
  parentEnvironmentId: PARENT_PREVIEW.id,
  branchName: "feat/x",
  paused: false,
  projectId: PROJECT_ID,
  organizationId: "org_1",
  archivedAt: null,
};

const ENVIRONMENTS = [PARENT_PREVIEW, BRANCH_CHILD];

const mocks = vi.hoisted(() => ({
  authenticateUserActor: vi.fn(),
  authenticatePat: vi.fn(),
  environmentFindFirst: vi.fn(),
  environmentFindMany: vi.fn(),
}));

// A stand-in for the Prisma filter the route builds: only the clauses this route uses.
function applyWhere(where: any) {
  return ENVIRONMENTS.filter((env) => {
    if (where.projectId !== env.projectId) return false;
    if ("id" in where && where.id !== env.id) return false;
    if ("parentEnvironmentId" in where && where.parentEnvironmentId !== env.parentEnvironmentId) {
      return false;
    }
    if ("archivedAt" in where && where.archivedAt !== env.archivedAt) return false;
    return true;
  });
}

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: mocks.authenticateUserActor,
    authenticatePat: mocks.authenticatePat,
  },
}));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {
    project: { findFirst: async () => ({ organizationId: "org_1" }) },
    runtimeEnvironment: {
      findFirst: mocks.environmentFindFirst,
      findMany: mocks.environmentFindMany,
    },
  },
}));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/models/project.server", () => ({
  findProjectByRef: async () => ({ id: PROJECT_ID, organizationId: "org_1" }),
}));
vi.mock("~/services/personalAccessToken.server", () => ({
  updateLastAccessedAtIfStale: vi.fn(),
  // The plugin already verified the claims; test tokens carry no source PAT, so the
  // liveness recheck is a no-op that hands the claims straight back.
  resolveAndRecheckUserActorClaims: async (claims: unknown) => claims,
}));
vi.mock("~/services/authTelemetry.server", () => ({ authenticateBearerWithTelemetry: vi.fn() }));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/tenantContext.server", () => ({
  tenantContext: { enrich: vi.fn() },
  tenantContextFromAuthEnvironment: vi.fn(),
}));
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () => ({
  WorkerGroupTokenService: class {},
}));
vi.mock("~/v3/services/common.server", () => ({ ServiceValidationError: class extends Error {} }));
vi.mock("@internal/run-engine", () => ({ EngineServiceValidationError: class extends Error {} }));

import { loader } from "~/routes/api.v1.projects.$projectRef.environments";

async function listEnvironments(token: string) {
  const response = await loader({
    request: new Request("https://api.trigger.dev/api/v1/projects/proj_ref/environments", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    params: { projectRef: "proj_ref" },
    context: {},
  } as any);
  return { status: response.status, body: await response.json() };
}

function agentToken(environmentId?: string) {
  return signUserActorToken(SESSION_SECRET, {
    userId: USER_ID,
    client: "dashboard-agent",
    ...(environmentId ? { environmentId } : {}),
    cap: ["read:environments"],
  });
}

describe("listing a project's environments with an environment-scoped token", () => {
  beforeEach(() => {
    mocks.authenticateUserActor.mockReset();
    mocks.authenticatePat.mockReset().mockResolvedValue({
      ok: true,
      userId: USER_ID,
      tokenId: "pat_1",
      ability: buildJwtAbility(["read:environments"]),
    });
    mocks.environmentFindFirst
      .mockReset()
      .mockImplementation(async ({ where }: any) =>
        ENVIRONMENTS.find(
          (env) =>
            env.id === where.id &&
            (where.projectId === undefined || env.projectId === where.projectId)
        )
      );
    mocks.environmentFindMany
      .mockReset()
      .mockImplementation(async ({ where }: any) => applyWhere(where));
  });

  it("lists the preview branch a token is scoped to", async () => {
    const token = await agentToken(BRANCH_CHILD.id);
    mocks.authenticateUserActor.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      claims: { userId: USER_ID, client: "dashboard-agent", environmentId: BRANCH_CHILD.id },
      ability: buildJwtAbility(["read:environments"]),
    });

    const result = await listEnvironments(token);

    expect(result.status).toBe(200);
    expect(result.body).toEqual([
      expect.objectContaining({ id: BRANCH_CHILD.id, branchName: "feat/x" }),
    ]);
  });

  it("lists only the environment a token is scoped to when it is a parent", async () => {
    const token = await agentToken(PARENT_PREVIEW.id);
    mocks.authenticateUserActor.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      claims: { userId: USER_ID, client: "dashboard-agent", environmentId: PARENT_PREVIEW.id },
      ability: buildJwtAbility(["read:environments"]),
    });

    const result = await listEnvironments(token);

    expect(result.status).toBe(200);
    expect(result.body).toEqual([expect.objectContaining({ id: PARENT_PREVIEW.id })]);
  });

  it("still hides branch children from an unscoped caller", async () => {
    const result = await listEnvironments("tr_pat_unscoped");

    expect(result.status).toBe(200);
    expect(result.body).toEqual([expect.objectContaining({ id: PARENT_PREVIEW.id })]);
  });
});
