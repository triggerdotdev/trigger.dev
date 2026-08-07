import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The eval-policy gate names an organization in its query, so the caller's membership is the
 * tenant floor. These drive the real route through the real preamble with real signed tokens;
 * only the database is stubbed.
 */

const { SESSION_SECRET } = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-eval-policy-auth",
}));

const mocks = vi.hoisted(() => ({
  organizationFindFirst: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET, APP_ORIGIN: "https://example.com" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateRequest: async () => undefined,
}));
vi.mock("~/db.server", () => ({
  prisma: {
    organization: { findFirst: mocks.organizationFindFirst },
    featureFlag: { findFirst: async () => null },
  },
  $replica: {},
}));

import { signUserActorToken } from "@trigger.dev/rbac";
import { loader } from "~/routes/api.v1.dashboard-agent.eval-policy";

const USER_ID = "usr_member";
const MEMBER_ORG = "org_member";
const OTHER_ORG = "org_other";
const ENV_IN_MEMBER_ORG = "env_aaaa";

function mintToken(opts: { environmentId?: string; client?: string } = {}) {
  return signUserActorToken(SESSION_SECRET, {
    userId: USER_ID,
    client: opts.client ?? "dashboard-agent",
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    cap: ["read:all"],
  });
}

function call(token: string | undefined, organizationId: string) {
  const request = new Request(
    `https://example.com/api/v1/dashboard-agent/eval-policy?organizationId=${organizationId}`,
    token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  );

  return loader({ request, params: {}, context: {} as any }) as Promise<Response>;
}

describe("dashboard agent eval policy", () => {
  beforeEach(() => {
    mocks.organizationFindFirst.mockReset();
    // Membership is the query's own filter, so the stub honours it rather than assuming it.
    mocks.organizationFindFirst.mockImplementation(async ({ where }: any) =>
      where.id === MEMBER_ORG && where.members?.some?.userId === USER_ID
        ? { featureFlags: {} }
        : null
    );
  });

  it("401s without a token", async () => {
    const response = await call(undefined, MEMBER_ORG);

    expect(response.status).toBe(401);
  });

  it("403s a user-actor token from another client", async () => {
    const token = await mintToken({ client: "personal-access-token" });

    const response = await call(token, MEMBER_ORG);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden_client" });
  });

  it("400s without an organization", async () => {
    const token = await mintToken({ environmentId: ENV_IN_MEMBER_ORG });

    const request = new Request("https://example.com/api/v1/dashboard-agent/eval-policy", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const response = (await loader({
      request,
      params: {},
      context: {} as any,
    })) as Response;

    expect(response.status).toBe(400);
  });

  it("answers no for an organization the token's user isn't a member of", async () => {
    const token = await mintToken({ environmentId: ENV_IN_MEMBER_ORG });

    const response = await call(token, OTHER_ORG);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ turnEvalsEnabled: false });
  });

  it("answers yes for an organization the token's user belongs to", async () => {
    const token = await mintToken({ environmentId: ENV_IN_MEMBER_ORG });

    const response = await call(token, MEMBER_ORG);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ turnEvalsEnabled: true });
  });

  it("scopes by membership rather than by the token's environment claim", async () => {
    // The route is org-level: the claim doesn't narrow it, and membership alone answers.
    const token = await mintToken({ environmentId: "env_elsewhere" });

    const response = await call(token, MEMBER_ORG);

    expect(response.status).toBe(200);
    expect(mocks.organizationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ members: { some: { userId: USER_ID } } }),
      })
    );
  });
});
