import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A user-actor token minted for one environment must not be honoured against another, even when
 * its user is a member of both. These drive each UAT-accepting route with a real token through the
 * real preamble and the real environment resolution; only the database and the RBAC plugin are stubbed.
 */

const { SESSION_SECRET } = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-uat-environment-claim",
}));

const mocks = vi.hoisted(() => {
  // Defaults to "PAT still live" so the many existing UAT route cases keep passing;
  // the recheck describe overrides it per-case.
  const assertSourcePatActive = vi.fn<(...args: any[]) => Promise<boolean>>();
  assertSourcePatActive.mockResolvedValue(true);
  return {
    can: vi.fn<(...args: any[]) => boolean>(),
    resolveRunCommit: vi.fn<(...args: any[]) => Promise<any>>(),
    resolveDashboardAgentRepoSnapshot: vi.fn<(...args: any[]) => Promise<any>>(),
    findCurrentWorkerFromEnvironment: vi.fn<(...args: any[]) => Promise<any>>(),
    assertSourcePatActive,
  };
});

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
  // A `tr_pat_` bearer resolves to the member user, driving the non-UAT branch.
  authenticateApiRequestWithPersonalAccessToken: async () => ({ userId: USER_ID }),
  isPersonalAccessToken: (token: string) => token.startsWith("tr_pat_"),
  assertSourcePatActive: mocks.assertSourcePatActive,
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
        KNOWN_USER_IDS.includes(where.id) ? { id: where.id } : null,
    },
    runtimeEnvironment: {
      // Enough of the where-clause to tell the rows apart the way Prisma would: the branchless
      // lookup keys on slug, the branch lookup on type + branchName, and dev of either kind is
      // additionally scoped to the calling member.
      findFirst: async ({ where }: any) =>
        ENVIRONMENTS.find((env) => {
          if (env.projectId !== where.projectId) return false;
          if (where.slug !== undefined && env.slug !== where.slug) return false;
          if (where.type !== undefined && env.type !== where.type) return false;
          if (where.branchName !== undefined && env.branchName !== where.branchName) return false;
          if (where.archivedAt !== undefined && env.archivedAt !== where.archivedAt) return false;
          if (where.orgMember?.userId && env.orgMemberUserId !== where.orgMember.userId)
            return false;
          return true;
        }) ?? null,
    },
    organization: {
      // The membership-scoped lookup behind an org-wide claim.
      findFirst: async ({ where }: any) =>
        where.id === ORGANIZATION.id && MEMBER_USER_IDS.includes(where.members?.some?.userId)
          ? { id: ORGANIZATION.id }
          : null,
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
// A real user of another organization: authenticates, but is a member of nothing here.
const OUTSIDER_USER_ID = "usr_outsider";
const KNOWN_USER_IDS = [...MEMBER_USER_IDS, OUTSIDER_USER_ID];

function environment(
  id: string,
  slug: string,
  type: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
  branchName: string | null = null
) {
  return {
    id,
    slug,
    type,
    branchName,
    archivedAt: null,
    // Dev rows are per-member; the others aren't scoped to one.
    orgMemberUserId: type === "DEVELOPMENT" ? USER_ID : null,
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

// The two branchable families: a parent and one of its branch children each. `upsertBranch` gives
// the child its own slug, but both rows answer to the same API env name — "preview", "dev".
const PREVIEW_BRANCH_NAME = "feat/checkout";
const DEV_BRANCH_NAME = "katia/spike";
const PREVIEW_PARENT = environment("env_preview", "preview", "PREVIEW");
const PREVIEW_BRANCH = {
  ...environment("env_preview_branch", "preview-feat-checkout", "PREVIEW", PREVIEW_BRANCH_NAME),
  // The resolver reads the parent to override the branch's api key.
  parentEnvironment: PREVIEW_PARENT,
};
const DEV_PARENT = environment("env_dev", "dev", "DEVELOPMENT");
const DEV_BRANCH = {
  ...environment("env_dev_branch", "dev-katia-spike", "DEVELOPMENT", DEV_BRANCH_NAME),
  parentEnvironment: DEV_PARENT,
};
const ENVIRONMENTS = [ENV_A, ENV_B, PREVIEW_PARENT, PREVIEW_BRANCH, DEV_PARENT, DEV_BRANCH];

function mintToken(
  opts: {
    environmentId?: string;
    organizationId?: string;
    client?: string;
    userId?: string;
  } = {}
) {
  return signUserActorToken(SESSION_SECRET, {
    userId: opts.userId ?? USER_ID,
    client: opts.client ?? "dashboard-agent",
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
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

// `branch` rides the same header the SDK and the agent's client send.
let branchHeader: string | undefined;

function requestFor(token: string, url: string, init?: RequestInit) {
  return new Request(`https://example.com${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(branchHeader ? { "x-trigger-branch": branchHeader } : {}),
    },
    ...init,
  });
}

/** Runs a route case with the branch header set for the duration of the call. */
async function withBranch<T>(branch: string | undefined, call: () => Promise<T>): Promise<T> {
  branchHeader = branch;
  try {
    return await call();
  } finally {
    branchHeader = undefined;
  }
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
 * Every environment shape the agent can be opened on, against the real routes. `preview` and `dev`
 * name a family rather than a row, so a branch is only addressable when `x-trigger-branch` travels
 * with the name — and a token minted for the branch is refused against the parent it otherwise
 * resolves to. Production and staging have no branch and must be unchanged by any of it.
 */
type EnvironmentCase = {
  name: string;
  env: string;
  branch?: string;
  expected: { id: string };
  /** The row a request without the branch lands on instead, for the branchable families. */
  fallsBackTo?: { id: string };
};

const ENVIRONMENT_CASES: EnvironmentCase[] = [
  { name: "production", env: "prod", expected: ENV_A },
  { name: "staging", env: "staging", expected: ENV_B },
  {
    name: "a preview branch",
    env: "preview",
    branch: PREVIEW_BRANCH_NAME,
    expected: PREVIEW_BRANCH,
    fallsBackTo: PREVIEW_PARENT,
  },
  {
    name: "a development branch",
    env: "dev",
    branch: DEV_BRANCH_NAME,
    expected: DEV_BRANCH,
    fallsBackTo: DEV_PARENT,
  },
];

describe.each(ENVIRONMENT_CASES)(
  "user-actor token on $name",
  ({ env, branch, expected, fallsBackTo }) => {
    beforeEach(() => {
      mocks.can.mockReset();
      mocks.can.mockReturnValue(true);
      mocks.findCurrentWorkerFromEnvironment.mockReset();
      mocks.findCurrentWorkerFromEnvironment.mockResolvedValue({
        id: "worker_1",
        friendlyId: "worker_1234",
        version: "20240101.1",
        engine: "V2",
        sdkVersion: "4.0.0",
        cliVersion: "4.0.0",
      });
    });

    it("mints for that exact environment", async () => {
      const token = await mintToken({ environmentId: expected.id });

      const response = await withBranch(branch, () => ROUTE_CASES[0].call(token, env));

      expect(response.status).toBe(200);
      const { token: jwt } = (await response.json()) as { token: string };
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
      expect(payload.sub).toBe(expected.id);
    });

    it("resolves that exact environment on the delegated-token reads too", async () => {
      const token = await mintToken({ environmentId: expected.id });

      const response = await withBranch(branch, () => ROUTE_CASES[2].call(token, env));

      expect(response.status).toBe(200);
      expect(mocks.findCurrentWorkerFromEnvironment.mock.calls[0][0]).toMatchObject({
        id: expected.id,
      });
    });

    if (fallsBackTo) {
      it("403s the branch's token when the branch didn't travel with it", async () => {
        const token = await mintToken({ environmentId: expected.id });

        const response = await ROUTE_CASES[0].call(token, env);

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "forbidden_environment" });
      });

      it("403s the parent's token when a branch did", async () => {
        const token = await mintToken({ environmentId: fallsBackTo.id });

        const response = await withBranch(branch, () => ROUTE_CASES[0].call(token, env));

        expect(response.status).toBe(403);
      });
    }
  }
);

/**
 * The exchange's own ceiling: a delegated token names the scopes it wants, and its `cap` is
 * what it may have. Without the intersection a read-only agent token mints a write JWT
 * whenever its user's role allows writes — the token travels in a task payload, so that is
 * a real widening rather than a theoretical one.
 */
/** An org-wide claim spans its whole organization, and stops at its edge. */
describe("env JWT exchange — org-wide token", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
  });

  it("mints for a sibling environment of the claimed organization", async () => {
    const token = await mintToken({ organizationId: ORGANIZATION.id });

    const response = await ROUTE_CASES[0].call(token, "staging");

    expect(response.status).toBe(200);
  });

  it("403s a claim for another organization", async () => {
    const token = await mintToken({ organizationId: "org_other" });

    const response = await ROUTE_CASES[0].call(token, "prod");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden_environment" });
  });

  it("refuses a non-member of the claimed organization", async () => {
    const token = await mintToken({ organizationId: ORGANIZATION.id, userId: OUTSIDER_USER_ID });

    const response = await ROUTE_CASES[0].call(token, "prod");

    // The project lookup is already membership-scoped, so a non-member never reaches the org check.
    expect(response.status).toBe(404);
  });
});

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

/**
 * The env-JWT exchange is the load-bearing UAT verify site. A token whose source PAT is no
 * longer live must be turned away there — `assertSourcePatActive` is the recheck, stubbed
 * here so the wiring is what's under test (its own logic is unit-tested separately).
 */
describe("env JWT exchange — source PAT liveness recheck", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
  });

  it("401s when the source PAT recheck fails", async () => {
    mocks.assertSourcePatActive.mockResolvedValueOnce(false);
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await ROUTE_CASES[0].call(token, "prod");

    expect(response.status).toBe(401);
  });

  it("mints when the source PAT recheck passes", async () => {
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await ROUTE_CASES[0].call(token, "prod");

    expect(response.status).toBe(200);
  });
});

/**
 * The scope ceiling closes the capless-token hole: a delegated token with no `cap` is
 * read-only, not full-admin, and the exchange projects requested scopes through the scope
 * grammar (so a `read:all` ceiling still admits reads rather than denying everything). The
 * TTL clamp keeps the minted JWT from outliving the token it was exchanged from.
 */
describe("env JWT exchange — capless ceiling and TTL clamp", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
  });

  function decodeJwt(jwt: string): { scopes?: string[]; exp?: number } {
    return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  }

  function mintUat(opts: { cap?: string[]; expirationTime?: number } = {}) {
    return signUserActorToken(SESSION_SECRET, {
      userId: USER_ID,
      client: "dashboard-agent",
      environmentId: ENV_A.id,
      ...(opts.cap ? { cap: opts.cap } : {}),
      ...(opts.expirationTime ? { expirationTime: opts.expirationTime } : {}),
    });
  }

  async function exchange(token: string, body: Record<string, unknown>) {
    const response = await respond(
      () =>
        jwtAction({
          request: requestFor(token, `/api/v1/projects/${PROJECT.externalRef}/prod/jwt`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
          params: { projectRef: PROJECT.externalRef, env: "prod" },
          context: {} as any,
        }) as Promise<Response>
    );
    expect(response.status).toBe(200);
    const { token: jwt } = (await response.json()) as { token: string };
    return decodeJwt(jwt);
  }

  it("denies admin to a capless token, projecting to the read-only ceiling", async () => {
    const token = await mintUat();

    const payload = await exchange(token, { claims: { scopes: ["admin"] } });

    expect(payload.scopes).toEqual([]);
    expect(payload.scopes).not.toContain("admin");
  });

  it("admits a read through the read:all wildcard ceiling", async () => {
    const token = await mintUat();

    const payload = await exchange(token, { claims: { scopes: ["read:runs"] } });

    expect(payload.scopes).toEqual(["read:runs"]);
  });

  it("defaults a capless token to the read-only ceiling", async () => {
    const token = await mintUat();

    const payload = await exchange(token, {});

    expect(payload.scopes).toEqual(["read:all"]);
  });

  it("passes a capped token's requested scopes through unchanged", async () => {
    const token = await mintUat({ cap: ["read:runs", "read:apiKeys"] });

    const payload = await exchange(token, { claims: { scopes: ["read:runs", "read:apiKeys"] } });

    expect(payload.scopes).toEqual(["read:runs", "read:apiKeys"]);
  });

  it("drops a scope the cap doesn't carry", async () => {
    const token = await mintUat({ cap: ["read:runs"] });

    const payload = await exchange(token, { claims: { scopes: ["read:runs", "write:runs"] } });

    expect(payload.scopes).toEqual(["read:runs"]);
  });

  it("preserves a write scope the cap carries", async () => {
    const token = await mintUat({ cap: ["write:errors"] });

    const payload = await exchange(token, { claims: { scopes: ["write:errors"] } });

    expect(payload.scopes).toEqual(["write:errors"]);
  });

  it("leaves a non-UAT (PAT) exchange's scopes untouched", async () => {
    const requested = ["read:runs", "write:runs", "admin"];

    const payload = await exchange("tr_pat_e2e_token", { claims: { scopes: requested } });

    expect(payload.scopes).toEqual(requested);
  });

  it("clamps the minted JWT lifetime to the token's own expiry", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenExp = nowSec + 600;
    const token = await mintUat({ expirationTime: tokenExp });

    const payload = await exchange(token, { expirationTime: "365d" });

    expect(payload.exp).toBeLessThanOrEqual(tokenExp + 1);
    expect(payload.exp).toBeGreaterThan(nowSec + 500);
  });
});

/**
 * The other direct verify site: the UAT preamble that fronts the repo-snapshot / workers /
 * commit reads. A token whose source PAT is no longer live must be turned away there too.
 * (`assertSourcePatActive` is stubbed; the snapshot route stands in for the preamble.)
 */
describe("UAT preamble — source PAT liveness recheck", () => {
  beforeEach(() => {
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
    mocks.resolveDashboardAgentRepoSnapshot.mockReset();
    mocks.resolveDashboardAgentRepoSnapshot.mockResolvedValue({
      url: "https://example.com/archive.tar.gz",
    });
  });

  it("401s a snapshot read when the source PAT recheck fails", async () => {
    mocks.assertSourcePatActive.mockResolvedValueOnce(false);
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await ROUTE_CASES[1].call(token, "prod");

    expect(response.status).toBe(401);
    expect(mocks.resolveDashboardAgentRepoSnapshot).not.toHaveBeenCalled();
  });

  it("serves the snapshot read when the source PAT recheck passes", async () => {
    const token = await mintToken({ environmentId: ENV_A.id });

    const response = await ROUTE_CASES[1].call(token, "prod");

    expect(response.status).toBe(200);
  });
});
