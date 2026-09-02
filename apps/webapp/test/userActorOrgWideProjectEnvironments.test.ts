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

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with one project, prod/staging/dev environments, a member and an outsider. */
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
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environmentFor = (envSlug: string, type: "PRODUCTION" | "STAGING" | "DEVELOPMENT") =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug}${suffix()}`,
        ...(type === "DEVELOPMENT" ? { orgMemberId: orgMember.id } : {}),
      },
    });

  return {
    member,
    outsider,
    organization,
    project,
    prod: await environmentFor("prod", "PRODUCTION"),
    staging: await environmentFor("stg", "STAGING"),
    dev: await environmentFor("dev", "DEVELOPMENT"),
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

postgresTest(
  "org-wide user-actor token lists a sibling project's environments",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const orgA = await seedOrg(prisma);
    const orgB = await seedOrg(prisma);

    // Its own org's project: every environment, dev included — the whole point of the sweep.
    const own = await callLoader({
      projectRef: orgA.project.externalRef,
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
    });
    expect(own.status).toBe(200);
    expect(own.body.map((env: any) => env.slug).sort()).toEqual(["dev", "prod", "stg"]);

    // A project outside the claimed organization is refused on the claim alone.
    const foreign = await callLoader({
      projectRef: orgB.project.externalRef,
      userId: orgA.member.id,
      organizationId: orgA.organization.id,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("forbidden_environment");

    // A claim naming the right org still needs membership of it.
    const outsider = await callLoader({
      projectRef: orgA.project.externalRef,
      userId: orgB.outsider.id,
      organizationId: orgA.organization.id,
    });
    expect(outsider.status).toBe(404);

    // The environment-claim path is unchanged: exactly its own environment, and nothing elsewhere.
    const scoped = await callLoader({
      projectRef: orgA.project.externalRef,
      userId: orgA.member.id,
      environmentId: orgA.staging.id,
    });
    expect(scoped.status).toBe(200);
    expect(scoped.body.map((env: any) => env.slug)).toEqual(["stg"]);

    const scopedForeign = await callLoader({
      projectRef: orgB.project.externalRef,
      userId: orgA.member.id,
      environmentId: orgA.staging.id,
    });
    expect(scopedForeign.status).toBe(403);
    expect(scopedForeign.body.code).toBe("forbidden_environment");
  }
);
