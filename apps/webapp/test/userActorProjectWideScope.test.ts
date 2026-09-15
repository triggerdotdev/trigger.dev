/**
 * The project-wide PAT routes (`/projects/:ref/environments`, `/projects/:ref/runs`) are the door
 * a delegated user-actor token could walk around its environment claim through: they list across a
 * project, so org membership alone would answer for every environment. These tests drive both real
 * routes against a real database with real signed tokens.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken } from "@trigger.dev/rbac";
import { expect, vi } from "vitest";
import * as webappRouteMocks from "./helpers/webappRouteMocks";

const SESSION_SECRET = "test-session-secret-for-project-wide-scope";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  patUserId: undefined as string | undefined,
  presenterEnvironments: [] as Array<{ id: string; organizationId: string } | undefined>,
}));

vi.mock("~/db.server", () => webappRouteMocks.dbServerProxyMock(ctx));
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: "test-session-secret-for-project-wide-scope" },
}));
vi.mock("~/services/logger.server", () => webappRouteMocks.loggerMock());
vi.mock("~/services/personalAccessToken.server", () => webappRouteMocks.personalAccessTokenMock());
vi.mock("~/services/authTelemetry.server", () => webappRouteMocks.authTelemetryMock());
vi.mock("~/services/tenantContext.server", () => webappRouteMocks.tenantContextMock());
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () =>
  webappRouteMocks.workerGroupTokenServiceMock()
);
vi.mock("~/v3/services/common.server", () => webappRouteMocks.serviceValidationErrorMock());
vi.mock("@internal/run-engine", () => webappRouteMocks.engineServiceValidationErrorMock());

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: vi.fn() },
}));

// The run list itself isn't under test — which environment the presenter is handed is.
vi.mock("~/presenters/v3/ApiRunListPresenter.server", async () => {
  const actual: any = await vi.importActual("~/presenters/v3/ApiRunListPresenter.server");
  return {
    ApiRunListSearchParams: actual.ApiRunListSearchParams,
    ApiRunListPresenter: class {
      async call(
        _project: unknown,
        _searchParams: unknown,
        _apiVersion: unknown,
        environment?: any
      ) {
        ctx.presenterEnvironments.push(
          environment
            ? { id: environment.id, organizationId: environment.organizationId }
            : undefined
        );
        return { data: [] };
      }
    },
  };
});

// The RBAC controller is the OSS fallback's behaviour: verify the token, ability from its own cap.
vi.mock("~/services/rbac.server", async () => {
  const { buildJwtAbility } = await import("@trigger.dev/rbac");
  const webappRouteMocks = await import("./helpers/webappRouteMocks");

  return {
    rbac: {
      authenticateUserActor: webappRouteMocks.ossAuthenticateUserActor(
        "test-session-secret-for-project-wide-scope"
      ),
      authenticatePat: async (_request: Request, context: any) => ({
        ok: true,
        tokenId: "tok_test",
        userId: ctx.patUserId,
        lastAccessedAt: null,
        subject: {
          type: "personalAccessToken",
          tokenId: "tok_test",
          organizationId: context.organizationId ?? "",
        },
        ability: buildJwtAbility(["admin"]),
      }),
    },
  };
});

const { loader: environmentsLoader } =
  await import("~/routes/api.v1.projects.$projectRef.environments");
const { loader: runsLoader } = await import("~/routes/api.v1.projects.$projectRef.runs");
const { loader: projectsLoader } = await import("~/routes/api.v1.projects");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with one project and two environments (prod + staging), and a member user. */
async function seedProject(prisma: PrismaClient) {
  const slug = `scope_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });

  const environmentFor = (envSlug: "prod" | "stg") =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type: envSlug === "prod" ? "PRODUCTION" : "STAGING",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug}${suffix()}`,
      },
    });

  return {
    user,
    organization,
    project,
    envA: await environmentFor("prod"),
    envB: await environmentFor("stg"),
  };
}

function agentToken(
  userId: string,
  environmentId?: string,
  client = "dashboard-agent",
  organizationId?: string
) {
  return signUserActorToken(SESSION_SECRET, {
    userId,
    client,
    ...(environmentId ? { environmentId } : {}),
    ...(organizationId ? { organizationId } : {}),
    cap: ["read:runs", "read:environments"],
  });
}

/** A second project of the same org, with a prod env and another member's own dev env. */
async function seedSibling(
  prisma: PrismaClient,
  organizationId: string
): Promise<{ project: { id: string; externalRef: string }; prodId: string; otherDevId: string }> {
  const slug = `sibling_${suffix()}`;
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId, externalRef: `proj_${slug}` },
  });
  const prod = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${suffix()}`,
    },
  });

  const other = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const membership = await prisma.orgMember.create({
    data: { organizationId, userId: other.id, role: "MEMBER" },
  });
  const otherDev = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId,
      orgMemberId: membership.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `d${suffix()}`,
    },
  });

  return { project, prodId: prod.id, otherDevId: otherDev.id };
}

async function call(
  loader: typeof environmentsLoader | typeof runsLoader,
  opts: { projectRef: string; token: string; search?: string }
) {
  const url = `https://api.trigger.dev/api/v1/projects/${opts.projectRef}/x${opts.search ?? ""}`;
  try {
    const response = await (loader as any)({
      request: new Request(url, { headers: { Authorization: `Bearer ${opts.token}` } }),
      params: { projectRef: opts.projectRef },
      context: {},
    });
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, body: await thrown.json() };
    }
    throw thrown;
  }
}

/** A PAT is prefixed `tr_pat_` so the route builder takes the PAT branch. */
const PAT = "tr_pat_testtoken";

type Seeded = Awaited<ReturnType<typeof seedProject>>;

/** Each case: the container's client wired in, one seeded project, a fresh presenter log. */
function scopeTest(name: string, fn: (seeded: Seeded) => Promise<void>) {
  postgresTest(
    name,
    async ({ prisma }) => {
      ctx.prisma = prisma;
      ctx.presenterEnvironments = [];
      const seeded = await seedProject(prisma);
      ctx.patUserId = seeded.user.id;
      await fn(seeded);
    },
    60_000
  );
}

scopeTest(
  "a user-actor token scoped to one environment lists only that environment",
  async (seeded) => {
    const scoped = await call(environmentsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, seeded.envA.id),
    });

    expect(scoped.status).toBe(200);
    expect(scoped.body.map((env: any) => env.id)).toEqual([seeded.envA.id]);
  }
);

scopeTest("a user-actor token sees only its own environment's runs", async (seeded) => {
  const scoped = await call(runsLoader, {
    projectRef: seeded.project.externalRef,
    token: await agentToken(seeded.user.id, seeded.envA.id),
  });

  expect(scoped.status).toBe(200);
  expect(ctx.presenterEnvironments).toEqual([
    { id: seeded.envA.id, organizationId: seeded.organization.id },
  ]);
});

scopeTest(
  "a user-actor token asking for another environment is refused, not overridden",
  async (seeded) => {
    const conflicting = await call(runsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, seeded.envA.id),
      search: `?filter[env]=${seeded.envB.slug}`,
    });

    expect(conflicting.status).toBe(403);
    expect(conflicting.body.code).toBe("forbidden_environment");
    expect(ctx.presenterEnvironments).toEqual([]);
  }
);

scopeTest("a claimless dashboard-agent token is refused", async (seeded) => {
  // The agent always mints per-environment, so a claimless one of its own is a bug, not a flow.
  const claimless = await call(environmentsLoader, {
    projectRef: seeded.project.externalRef,
    token: await agentToken(seeded.user.id, undefined),
  });

  expect(claimless.status).toBe(403);
  expect(claimless.body.code).toBe("forbidden_environment");
});

// Both of these read the whole project as they always have: the public PAT exchange mints
// claimless tokens, so narrowing either would be a breaking change. No forced environment, and
// the request's own filter is honoured rather than refused.
const projectWide: Array<[string, (seeded: Seeded) => Promise<string> | string]> = [
  [
    "a claimless user-actor token from another client",
    (seeded) => agentToken(seeded.user.id, undefined, "mcp"),
  ],
  ["a personal access token", () => PAT],
];

for (const [who, tokenFor] of projectWide) {
  scopeTest(`${who} still gets the project-wide answer`, async (seeded) => {
    const environments = await call(environmentsLoader, {
      projectRef: seeded.project.externalRef,
      token: await tokenFor(seeded),
    });

    expect(environments.status).toBe(200);
    expect(environments.body.map((env: any) => env.id).sort()).toEqual(
      [seeded.envA.id, seeded.envB.id].sort()
    );

    const runs = await call(runsLoader, {
      projectRef: seeded.project.externalRef,
      token: await tokenFor(seeded),
      search: `?filter[env]=${seeded.envB.slug}`,
    });

    expect(runs.status).toBe(200);
    expect(ctx.presenterEnvironments).toEqual([undefined]);
  });
}

scopeTest(
  "an organization-scoped token lists a sibling project, without other members' dev environments",
  async (seeded) => {
    const sibling = await seedSibling(ctx.prisma, seeded.organization.id);

    const response = await call(environmentsLoader, {
      projectRef: sibling.project.externalRef,
      token: await agentToken(
        seeded.user.id,
        seeded.envA.id,
        "dashboard-agent",
        seeded.organization.id
      ),
    });

    expect(response.status).toBe(200);
    expect(response.body.map((env: any) => env.id)).toEqual([sibling.prodId]);
  }
);

scopeTest("a token claiming another organization is refused", async (seeded) => {
  const foreign = await ctx.prisma.organization.create({
    data: { title: `foreign_${suffix()}`, slug: `foreign_${suffix()}` },
  });

  const response = await call(environmentsLoader, {
    projectRef: seeded.project.externalRef,
    token: await agentToken(seeded.user.id, seeded.envA.id, "dashboard-agent", foreign.id),
  });

  expect(response.status).toBe(403);
  expect(response.body.code).toBe("forbidden_environment");
});

/** The projects list names no organization, so only the claim can narrow it. */
async function listProjects(token: string) {
  const request = new Request("https://api.trigger.dev/api/v1/projects", {
    headers: { Authorization: `Bearer ${token}` },
  });
  try {
    const response = await (projectsLoader as any)({ request, params: {}, context: {} });
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, body: await thrown.json() };
    }
    throw thrown;
  }
}

/** A V3 project in another organization the same user belongs to. */
async function seedSecondOrganization(prisma: PrismaClient, userId: string) {
  const slug = `other_${suffix()}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId, role: "ADMIN" },
  });
  return prisma.project.create({
    data: {
      name: slug,
      slug,
      organizationId: organization.id,
      externalRef: `proj_${slug}`,
      version: "V3",
    },
  });
}

scopeTest(
  "an organization-scoped token lists only that organization's projects",
  async (seeded) => {
    await ctx.prisma.project.update({ where: { id: seeded.project.id }, data: { version: "V3" } });
    const elsewhere = await seedSecondOrganization(ctx.prisma, seeded.user.id);

    const scoped = await listProjects(
      await agentToken(seeded.user.id, seeded.envA.id, "dashboard-agent", seeded.organization.id)
    );

    expect(scoped.status).toBe(200);
    expect(scoped.body.map((project: any) => project.id)).toEqual([seeded.project.id]);
    expect(scoped.body.map((project: any) => project.id)).not.toContain(elsewhere.id);
  }
);

scopeTest("a personal access token still lists every organization's projects", async (seeded) => {
  await ctx.prisma.project.update({ where: { id: seeded.project.id }, data: { version: "V3" } });
  const elsewhere = await seedSecondOrganization(ctx.prisma, seeded.user.id);

  const all = await listProjects(PAT);

  expect(all.status).toBe(200);
  expect(all.body.map((project: any) => project.id).sort()).toEqual(
    [seeded.project.id, elsewhere.id].sort()
  );
});
