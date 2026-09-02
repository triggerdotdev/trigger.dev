/**
 * The environments route is the agent's cross-project sweep: an org-wide user-actor token lists
 * any project of its own organization, and nothing outside it. Driven through the real loader
 * against a real database, because membership — not the claim — is the tenant floor.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { buildJwtAbility, signUserActorToken } from "@trigger.dev/rbac";
import { expect, vi } from "vitest";

const SESSION_SECRET = "test-session-secret";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

const mocks = vi.hoisted(() => ({ authenticateUserActor: vi.fn() }));

vi.mock("~/services/rbac.server", () => ({
  rbac: { authenticateUserActor: mocks.authenticateUserActor, authenticatePat: vi.fn() },
}));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/personalAccessToken.server", async () => {
  const { verifyUserActorToken } = await import("@trigger.dev/rbac");
  return {
    updateLastAccessedAtIfStale: vi.fn(),
    resolveAndRecheckUserActorClaims: async (claims: unknown, bearer: string) =>
      claims ?? (await verifyUserActorToken(SESSION_SECRET, bearer)),
  };
});
vi.mock("~/services/authTelemetry.server", () => ({
  authenticateBearerWithTelemetry: vi.fn(),
}));
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
vi.mock("~/v3/services/common.server", () => ({
  ServiceValidationError: class extends Error {},
}));
vi.mock("@internal/run-engine", () => ({
  EngineServiceValidationError: class extends Error {},
}));

const { loader } = await import("~/routes/api.v1.projects.$projectRef.environments");
const { assertUserActorScope, resolveUserActorEnvironmentScope } =
  await import("~/services/userActorEnvironment.server");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with two projects, each with prod/staging/dev environments, a member and an outsider. */
async function seedOrg(prisma: PrismaClient) {
  const slug = `orgenvs_${suffix()}`;
  const member = await prisma.user.create({
    data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const outsider = await prisma.user.create({
    data: { email: `${slug}-outsider@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const orgMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: member.id, role: "ADMIN" },
  });

  async function projectWithEnvironments(name: string) {
    const projectSlug = `${slug}_${name}`;
    const project = await prisma.project.create({
      data: {
        name: projectSlug,
        slug: projectSlug,
        organizationId: organization.id,
        externalRef: `proj_${projectSlug}`,
      },
    });
    const environmentFor = (envSlug: string, type: "PRODUCTION" | "STAGING" | "DEVELOPMENT") =>
      prisma.runtimeEnvironment.create({
        data: {
          slug: envSlug,
          type,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_${envSlug}_${projectSlug}`,
          pkApiKey: `pk_${envSlug}_${projectSlug}`,
          shortcode: `${envSlug}${suffix()}`,
          ...(type === "DEVELOPMENT" ? { orgMemberId: orgMember.id } : {}),
        },
      });

    return {
      project,
      prod: await environmentFor("prod", "PRODUCTION"),
      staging: await environmentFor("stg", "STAGING"),
      dev: await environmentFor("dev", "DEVELOPMENT"),
    };
  }

  return {
    member,
    outsider,
    organization,
    current: await projectWithEnvironments("current"),
    sibling: await projectWithEnvironments("sibling"),
  };
}

async function callLoader(opts: {
  projectRef: string;
  userId: string;
  organizationId?: string;
  environmentId?: string;
}): Promise<{ status: number; body: any }> {
  const claims = {
    userId: opts.userId,
    client: "dashboard-agent",
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
  };
  const token = await signUserActorToken(SESSION_SECRET, {
    ...claims,
    cap: ["read:environments"],
  });
  mocks.authenticateUserActor.mockImplementation(async () => ({
    ok: true,
    userId: opts.userId,
    claims,
    subject: { type: "userActor", userId: opts.userId },
    ability: buildJwtAbility(["read:environments"]),
  }));

  const response = await loader({
    request: new Request(
      `https://api.trigger.dev/api/v1/projects/${opts.projectRef}/environments`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
    params: { projectRef: opts.projectRef },
    context: {},
  } as any);

  return { status: response.status, body: await response.json() };
}

async function statusOf(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

postgresTest(
  "org-wide user-actor token lists a sibling project's environments",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);

    // The shape the dashboard agent actually mints: the turn's environment plus its organization.
    const minted = {
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.current.dev.id,
    };

    // A sibling project of the same org — the sweep this whole route exists for. Every
    // environment, dev included, none of them the one the token was minted for.
    const sibling = await callLoader({ ...minted, projectRef: orgA.sibling.project.externalRef });
    expect(sibling.status).toBe(200);
    expect(sibling.body.map((env: any) => env.slug).sort()).toEqual(["dev", "prod", "stg"]);

    // Its own project answers the same way: with an org claim, the org is the boundary.
    const own = await callLoader({ ...minted, projectRef: orgA.current.project.externalRef });
    expect(own.status).toBe(200);
    expect(own.body.map((env: any) => env.slug).sort()).toEqual(["dev", "prod", "stg"]);

    // A project outside the claimed organization.
    const foreign = await callLoader({ ...minted, projectRef: orgB.current.project.externalRef });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("forbidden_environment");

    // A claim naming the right org still needs membership of it.
    const outsider = await callLoader({
      projectRef: orgA.current.project.externalRef,
      userId: orgB.outsider.id,
      organizationId: orgA.organization.id,
    });
    expect(outsider.status).toBe(404);

    // An environment claim with no org claim is unchanged: that environment only, and nothing
    // in another project.
    const envOnly = { userId: orgA.member.id, environmentId: orgA.current.staging.id };
    const scoped = await callLoader({ ...envOnly, projectRef: orgA.current.project.externalRef });
    expect(scoped.status).toBe(200);
    expect(scoped.body.map((env: any) => env.slug)).toEqual(["stg"]);

    const scopedSibling = await callLoader({
      ...envOnly,
      projectRef: orgA.sibling.project.externalRef,
    });
    expect(scopedSibling.status).toBe(403);
    expect(scopedSibling.body.code).toBe("forbidden_environment");

    // The control: a route that hasn't opted in refuses the same org-wide token, so nothing is
    // loosened for the PAT routes at large.
    const claims = { ...minted, client: "dashboard-agent" };
    expect(
      await statusOf(
        resolveUserActorEnvironmentScope(claims, { projectId: orgA.sibling.project.id })
      )
    ).toBe(403);
    expect(
      await statusOf(
        assertUserActorScope(claims, {
          organizationId: orgA.organization.id,
          projectId: orgA.sibling.project.id,
        })
      )
    ).toBe(403);
  }
);
