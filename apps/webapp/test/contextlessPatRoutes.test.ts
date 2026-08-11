import { buildJwtAbility, signUserActorToken } from "@trigger.dev/rbac";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The two PAT routes that name no org or project. Creating an organization is a mutation
// reachable with nothing but an authenticated identity, so it declares a gate even though there
// is no org yet to scope it to. Listing projects is identity-only, and the dashboard agent's
// environment-scoped token has to keep reaching it.

const SESSION_SECRET = "test-session-secret";

const mocks = vi.hoisted(() => ({
  authenticateUserActor: vi.fn(),
  authenticatePat: vi.fn(),
  createOrganization: vi.fn(),
  findManyProjects: vi.fn(),
  env: { SESSION_SECRET: "test-session-secret", ORG_CREATION_API_ENABLED: "1" } as {
    SESSION_SECRET: string;
    ORG_CREATION_API_ENABLED?: string;
  },
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: mocks.authenticateUserActor,
    authenticatePat: mocks.authenticatePat,
  },
}));
vi.mock("~/db.server", () => ({
  prisma: { project: { findMany: mocks.findManyProjects } },
  $replica: {},
}));
vi.mock("~/env.server", () => ({ env: mocks.env }));
vi.mock("~/models/organization.server", () => ({ createOrganization: mocks.createOrganization }));
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

import { action } from "~/routes/api.v1.orgs";
import { loader as projectsLoader } from "~/routes/api.v1.projects";

const USER_ID = "usr_1";

// Counts `can()` invocations without changing what the ability answers.
function countingAbility(ability: any): { ability: any; canCalls: () => number } {
  let canCalls = 0;
  const wrapped = new Proxy(ability, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (prop === "can") {
        return (...args: any[]) => {
          canCalls++;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { ability: wrapped, canCalls: () => canCalls };
}

async function createOrg(cap: string[]): Promise<{ status: number; body: any; canCalls: number }> {
  const token = await signUserActorToken(SESSION_SECRET, {
    userId: USER_ID,
    client: "personal-access-token",
    cap,
  });
  const counted = countingAbility(buildJwtAbility(cap));
  mocks.authenticateUserActor.mockImplementation(async () => ({
    ok: true,
    userId: USER_ID,
    claims: { userId: USER_ID, client: "personal-access-token", cap },
    subject: { type: "userActor", userId: USER_ID, organizationId: "org_1" },
    ability: counted.ability,
  }));

  const response = await action({
    request: new Request("https://api.trigger.dev/api/v1/orgs", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Org" }),
    }),
    params: {},
    context: {},
  } as any);
  return { status: response.status, body: await response.json(), canCalls: counted.canCalls() };
}

// An ordinary PAT, paired with an ability that denies everything. Nothing on this route may
// consult it — the route has no org to scope a gate to, and on cloud the plugin returns a
// deny-shaped ability when there is no org context.
async function createOrgWithPat(): Promise<{ status: number; body: any; canCalls: number }> {
  let canCalls = 0;
  mocks.authenticatePat.mockImplementation(async () => ({
    ok: true,
    userId: USER_ID,
    tokenId: "pat_1",
    lastAccessedAt: new Date(),
    ability: {
      can: () => {
        canCalls++;
        return false;
      },
      canSuper: () => false,
    },
  }));

  const response = await action({
    request: new Request("https://api.trigger.dev/api/v1/orgs", {
      method: "POST",
      headers: { Authorization: "Bearer tr_pat_1234", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Org" }),
    }),
    params: {},
    context: {},
  } as any);
  return { status: response.status, body: await response.json(), canCalls };
}

const AGENT_ENVIRONMENT_ID = "env_dev";

async function listProjects(): Promise<{ status: number; body: any }> {
  const claims = {
    userId: USER_ID,
    client: "dashboard-agent",
    environmentId: AGENT_ENVIRONMENT_ID,
    cap: ["read:runs"],
  };
  const token = await signUserActorToken(SESSION_SECRET, claims);
  mocks.authenticateUserActor.mockImplementation(async () => ({
    ok: true,
    userId: USER_ID,
    claims,
    subject: { type: "userActor", userId: USER_ID, organizationId: "org_1" },
    ability: buildJwtAbility(claims.cap),
  }));

  const response = await projectsLoader({
    request: new Request("https://api.trigger.dev/api/v1/projects", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    params: {},
    context: {},
  } as any);
  return { status: response.status, body: await response.json() };
}

describe("listing projects over the API", () => {
  it("stays reachable by an environment-scoped agent token", async () => {
    mocks.findManyProjects.mockResolvedValue([
      {
        id: "proj_1",
        externalRef: "proj_ref_1",
        name: "Test",
        slug: "test",
        createdAt: new Date(),
        defaultWorkerGroup: { name: "eu" },
        organization: { id: "org_1", title: "Org", slug: "org", createdAt: new Date() },
      },
    ]);

    const result = await listProjects();

    expect(result.status).toBe(200);
    expect(result.body[0].externalRef).toBe("proj_ref_1");
  });
});

describe("creating an organization over the API", () => {
  // Creation always succeeds if it is reached, so a refusal is the gate and nothing else.
  beforeEach(() => {
    mocks.createOrganization.mockReset();
    mocks.createOrganization.mockResolvedValue({
      id: "org_new",
      title: "New Org",
      slug: "new-org",
      createdAt: new Date(),
    });
  });

  it("refuses a token capped to reads", async () => {
    const result = await createOrg(["read:all"]);

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("unauthorized");
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it("admits an ordinary PAT without consulting its ability", async () => {
    const result = await createOrgWithPat();

    expect(result.status).toBe(201);
    expect(result.body.slug).toBe("new-org");
    expect(result.canCalls).toBe(0);
  });

  // The env gate runs before the capability gate, so an install with the API disabled tells
  // every caller the same thing: the route does not exist. A capped token must not learn from a
  // 403 that it would have been the only thing standing in its way.
  it("hides the route from a capped token when the API is disabled", async () => {
    mocks.env.ORG_CREATION_API_ENABLED = undefined;

    try {
      const result = await createOrg(["read:all"]);

      expect(result.status).toBe(404);
      expect(result.canCalls).toBe(0);
      expect(mocks.createOrganization).not.toHaveBeenCalled();
    } finally {
      mocks.env.ORG_CREATION_API_ENABLED = "1";
    }
  });

  it("still admits a token that carries the universal grant", async () => {
    const result = await createOrg(["admin"]);

    expect(result.status).toBe(201);
    expect(result.body.slug).toBe("new-org");
  });
});
