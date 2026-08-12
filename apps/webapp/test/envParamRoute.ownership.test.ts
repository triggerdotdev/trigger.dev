import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user_me", admin: false, isImpersonating: false },
  project: null as unknown,
  updatedEnvironmentIds: [] as string[],
}));

vi.mock("~/db.server", () => ({
  prisma: {
    project: {
      findFirst: async () => mocks.project,
    },
  },
  $replica: {},
}));

vi.mock("~/services/session.server", () => ({
  requireUser: async () => mocks.user,
  hasAdminDisplayAccess: (user: {
    admin: boolean;
    isImpersonating: boolean;
    isViewingAsUser?: boolean;
  }) => (user.admin || user.isImpersonating) && !user.isViewingAsUser,
}));

vi.mock("~/services/dashboardPreferences.server", () => ({
  updateCurrentProjectEnvironmentId: async ({ environmentId }: { environmentId: string }) => {
    mocks.updatedEnvironmentIds.push(environmentId);
  },
}));

vi.mock("~/services/tenantContext.server", () => ({
  tenantContext: { enrich: () => {} },
}));

vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => false,
}));

vi.mock("~/services/logger.server", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

import { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam/route";

const PARAMS = {
  organizationSlug: "acme",
  projectParam: "my-project",
  envParam: "dev",
};

function devEnvironment(id: string, userId: string) {
  return { id, type: "DEVELOPMENT" as const, slug: "dev", orgMember: { userId } };
}

function projectWith(environments: unknown[]) {
  return {
    id: "project_1",
    externalRef: "proj_abc",
    organization: { id: "org_1", featureFlags: {} },
    environments,
  };
}

async function callLoader(params: typeof PARAMS = PARAMS) {
  return (await loader({
    request: new Request(
      `http://localhost:3030/orgs/acme/projects/my-project/env/${params.envParam}`
    ),
    params,
    context: {},
  } as never)) as Response;
}

describe("env.$envParam loader — development environment ownership", () => {
  beforeEach(() => {
    mocks.updatedEnvironmentIds.length = 0;
  });

  it("resolves the caller's own dev environment when several members have one", async () => {
    mocks.project = projectWith([
      devEnvironment("env_colleague", "user_colleague"),
      devEnvironment("env_mine", "user_me"),
    ]);

    await callLoader();

    expect(mocks.updatedEnvironmentIds).toEqual(["env_mine"]);
  });

  it("redirects rather than adopting the only other member's dev environment", async () => {
    mocks.project = projectWith([devEnvironment("env_colleague", "user_colleague")]);

    const response = await callLoader();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/orgs/acme/projects/my-project");
    expect(mocks.updatedEnvironmentIds).toEqual([]);
  });

  it("resolves a development branch to the caller's own, not a colleague's", async () => {
    mocks.project = projectWith([
      {
        id: "env_branch_theirs",
        type: "DEVELOPMENT" as const,
        slug: "dev-foo",
        orgMember: { userId: "user_colleague" },
      },
      {
        id: "env_branch_mine",
        type: "DEVELOPMENT" as const,
        slug: "dev-foo",
        orgMember: { userId: "user_me" },
      },
    ]);

    await callLoader({ ...PARAMS, envParam: "dev-foo" });

    expect(mocks.updatedEnvironmentIds).toEqual(["env_branch_mine"]);
  });

  it("still resolves shared environments that belong to no member", async () => {
    mocks.project = projectWith([
      { id: "env_prod", type: "PRODUCTION" as const, slug: "dev", orgMember: null },
    ]);

    await callLoader();

    expect(mocks.updatedEnvironmentIds).toEqual(["env_prod"]);
  });
});
