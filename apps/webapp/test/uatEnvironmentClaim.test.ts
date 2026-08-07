import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A user-actor token minted for one environment must not be honoured against another, even when
 * its user is a member of both. These drive each UAT-accepting route with a real token through the
 * real preamble and the real environment resolution; only the database and the RBAC plugin are stubbed.
 */

const { SESSION_SECRET } = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-uat-environment-claim",
}));

const mocks = vi.hoisted(() => ({
  can: vi.fn<(...args: any[]) => boolean>(),
  resolveRunCommit: vi.fn<(...args: any[]) => Promise<any>>(),
  resolveDashboardAgentRepoSnapshot: vi.fn<(...args: any[]) => Promise<any>>(),
  findCurrentWorkerFromEnvironment: vi.fn<(...args: any[]) => Promise<any>>(),
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
    externalRef === PROJECT.externalRef && MEMBER_USER_IDS.includes(userId) ? PROJECT : null,
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
      findUnique: async ({ where }: any) =>
        MEMBER_USER_IDS.includes(where.id) ? { id: where.id } : null,
    },
    runtimeEnvironment: {
      findFirst: async ({ where }: any) =>
        ENVIRONMENTS.find((env) => env.projectId === where.projectId && env.slug === where.slug) ??
        null,
    },
    workerDeployment: { findFirst: async () => null },
    backgroundWorkerTask: { findMany: async () => [] },
  },
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  resolveRunCommit: mocks.resolveRunCommit,
  resolveDashboardAgentRepoSnapshot: mocks.resolveDashboardAgentRepoSnapshot,
}));
vi.mock("~/v3/models/workerDeployment.server", () => ({
  findCurrentWorkerFromEnvironment: mocks.findCurrentWorkerFromEnvironment,
}));

import { signUserActorToken } from "@trigger.dev/rbac";
import { action as jwtAction } from "~/routes/api.v1.projects.$projectRef.$env.jwt";
import { loader as commitLoader } from "~/routes/api.v1.projects.$projectRef.$env.runs.$runId.commit";
import { loader as snapshotLoader } from "~/routes/api.v1.projects.$projectRef.$env.repo.snapshot";
import { loader as workersLoader } from "~/routes/api.v1.projects.$projectRef.$env.workers.$tagName";
import { authenticatedEnvironmentForAuthentication } from "~/services/apiAuth.server";
import { assertUserActorEnvironment } from "~/services/userActorEnvironment.server";

const ORGANIZATION = { id: "org_1234", slug: "test-org" };
const PROJECT = { id: "proj_1234", externalRef: "proj_ref_1234", slug: "test-project" };
const USER_ID = "usr_member";
const MEMBER_USER_IDS = [USER_ID];

function environment(id: string, slug: string, type: "PRODUCTION" | "STAGING") {
  return {
    id,
    slug,
    type,
    apiKey: `tr_${slug}_abcdefghijklmnop`,
    organizationId: ORGANIZATION.id,
    organization: ORGANIZATION,
    projectId: PROJECT.id,
    project: PROJECT,
  };
}

// Two environments of the same project, both reachable by the same member.
const ENV_A = environment("env_aaaa", "prod", "PRODUCTION");
const ENV_B = environment("env_bbbb", "stg", "STAGING");
const ENVIRONMENTS = [ENV_A, ENV_B];

function mintToken(opts: { environmentId?: string; client?: string } = {}) {
  return signUserActorToken(SESSION_SECRET, {
    userId: USER_ID,
    client: opts.client ?? "dashboard-agent",
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    cap: ["read:apiKeys", "read:runs", "read:deployments"],
  });
}

/** A route throws its json Response for the failures it doesn't build itself. */
async function respond(call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

function requestFor(token: string, url: string, init?: RequestInit) {
  return new Request(`https://example.com${url}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...init,
  });
}

type RouteCase = {
  name: string;
  /** `env` is the URL slug the route resolves from, not the environment id. */
  call: (token: string, env: string) => Promise<Response>;
};

const ROUTE_CASES: RouteCase[] = [
  {
    name: "env JWT exchange",
    call: (token, env) =>
      respond(
        () =>
          jwtAction({
            request: requestFor(token, `/api/v1/projects/${PROJECT.externalRef}/${env}/jwt`, {
              method: "POST",
              body: JSON.stringify({}),
            }),
            params: { projectRef: PROJECT.externalRef, env },
            context: {} as any,
          }) as Promise<Response>
      ),
  },
  {
    name: "repo snapshot",
    call: (token, env) =>
      respond(
        () =>
          snapshotLoader({
            request: requestFor(
              token,
              `/api/v1/projects/${PROJECT.externalRef}/${env}/repo/snapshot`
            ),
            params: { projectRef: PROJECT.externalRef, env },
            context: {} as any,
          }) as Promise<Response>
      ),
  },
  {
    name: "worker by tag",
    call: (token, env) =>
      respond(
        () =>
          workersLoader({
            request: requestFor(
              token,
              `/api/v1/projects/${PROJECT.externalRef}/${env}/workers/current`
            ),
            params: { projectRef: PROJECT.externalRef, env, tagName: "current" },
            context: {} as any,
          }) as Promise<Response>
      ),
  },
  {
    name: "run commit",
    call: (token, env) =>
      respond(
        () =>
          commitLoader({
            request: requestFor(
              token,
              `/api/v1/projects/${PROJECT.externalRef}/${env}/runs/run_1234/commit`
            ),
            params: { projectRef: PROJECT.externalRef, env, runId: "run_1234" },
            context: {} as any,
          }) as Promise<Response>
      ),
  },
];

describe("user-actor token environment scope", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
    mocks.resolveRunCommit.mockResolvedValue({
      sha: "abc123",
      version: "20240101.1",
      dirty: false,
    });
    mocks.resolveDashboardAgentRepoSnapshot.mockResolvedValue({
      url: "https://example.com/archive.tar.gz",
    });
    mocks.findCurrentWorkerFromEnvironment.mockResolvedValue({
      id: "worker_1",
      friendlyId: "worker_1234",
      version: "20240101.1",
      engine: "V2",
      sdkVersion: "4.0.0",
      cliVersion: "4.0.0",
    });
  });

  describe.each(ROUTE_CASES)("$name", ({ call }) => {
    it("403s a token minted for another environment", async () => {
      const token = await mintToken({ environmentId: ENV_A.id });

      const response = await call(token, "staging");

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden_environment" });
    });

    it("allows the environment the token was minted for", async () => {
      const token = await mintToken({ environmentId: ENV_A.id });

      const response = await call(token, "prod");

      expect(response.status).toBe(200);
    });

    it("refuses an agent token that carries no environment claim", async () => {
      // A mint that couldn't resolve an environment must not produce a token that passes
      // every gate, so a claimless agent token is a bug rather than a flow.
      const token = await mintToken();

      const response = await call(token, "staging");

      expect(response.status).toBe(403);
    });

    it("allows an environment-agnostic token from another client", async () => {
      const token = await mintToken({ client: "personal-access-token" });

      const response = await call(token, "staging");

      expect(response.status).toBe(200);
    });
  });

  it("leaves a caller with no user-actor token alone", async () => {
    const resolved = await authenticatedEnvironmentForAuthentication(
      { type: "personalAccessToken", result: { userId: USER_ID } },
      PROJECT.externalRef,
      "stg"
    );

    expect(resolved.id).toBe(ENV_B.id);
  });

  it("throws only on a mismatch", () => {
    expect(() => assertUserActorEnvironment(undefined, ENV_A.id)).not.toThrow();
    expect(() => assertUserActorEnvironment({ userId: USER_ID }, ENV_A.id)).not.toThrow();
    expect(() =>
      assertUserActorEnvironment({ userId: USER_ID, environmentId: ENV_A.id }, ENV_A.id)
    ).not.toThrow();
    expect(() =>
      assertUserActorEnvironment({ userId: USER_ID, environmentId: ENV_A.id }, ENV_B.id)
    ).toThrow();
  });
});

/**
 * The exchange's own ceiling: a delegated token names the scopes it wants, and its `cap` is
 * what it may have. Without the intersection a read-only agent token mints a write JWT
 * whenever its user's role allows writes — the token travels in a task payload, so that is
 * a real widening rather than a theoretical one.
 */
describe("env JWT exchange — the cap is a ceiling", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
  });

  async function exchange(token: string, scopes?: string[]) {
    const response = await respond(
      () =>
        jwtAction({
          request: requestFor(token, `/api/v1/projects/${PROJECT.externalRef}/prod/jwt`, {
            method: "POST",
            body: JSON.stringify(scopes ? { claims: { scopes } } : {}),
          }),
          params: { projectRef: PROJECT.externalRef, env: "prod" },
          context: {} as any,
        }) as Promise<Response>
    );
    return response;
  }

  it("drops a scope the cap doesn't carry", async () => {
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await exchange(token, ["read:runs", "write:runs"]);

    expect(response.status).toBe(200);
    const { token: jwt } = (await response.json()) as { token: string };
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as {
      scopes?: string[];
    };
    expect(payload.scopes).toEqual(["read:runs"]);
  });

  it("falls back to the whole cap when the caller asks for nothing", async () => {
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await exchange(token);

    const { token: jwt } = (await response.json()) as { token: string };
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as {
      scopes?: string[];
    };
    expect(payload.scopes).toEqual(["read:apiKeys", "read:runs", "read:deployments"]);
  });
});

describe("repo snapshot authorization", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.resolveDashboardAgentRepoSnapshot.mockReset();
    mocks.resolveDashboardAgentRepoSnapshot.mockResolvedValue({
      url: "https://example.com/archive.tar.gz",
    });
  });

  it("403s a role that can't read the environment's secrets", async () => {
    mocks.can.mockReturnValue(false);
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await ROUTE_CASES[1].call(token, "prod");

    expect(response.status).toBe(403);
    expect(mocks.resolveDashboardAgentRepoSnapshot).not.toHaveBeenCalled();
  });

  it("serves the archive pointer to a role that can", async () => {
    mocks.can.mockReturnValue(true);
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await ROUTE_CASES[1].call(token, "prod");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: "https://example.com/archive.tar.gz" });
  });
});
