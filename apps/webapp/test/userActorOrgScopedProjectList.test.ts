/**
 * The project list is the agent's discovery step: an org-scoped user-actor token sees only the
 * projects of its own organization, enforced by the query rather than by the caller. Driven
 * through the real loader against a real database, because membership stays the tenant floor.
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
vi.mock("@internal/run-engine", () => ({ EngineServiceValidationError: class extends Error {} }));

const { loader } = await import("~/routes/api.v1.projects");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An org with one V3 project and a dev environment, plus an optional existing member. */
async function seedOrg(prisma: PrismaClient, member?: { id: string }) {
  const slug = `orgprojects_${suffix()}`;
  const user =
    member ??
    (await prisma.user.create({
      data: { email: `${slug}-member@example.com`, authenticationMethod: "MAGIC_LINK" },
    }));
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const orgMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: {
      name: slug,
      slug,
      version: "V3",
      organizationId: organization.id,
      externalRef: `proj_${slug}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `dev${suffix()}`,
      orgMemberId: orgMember.id,
    },
  });

  return { user, organization, project, environment };
}

async function callLoader(opts: {
  userId: string;
  organizationId?: string;
  environmentId?: string;
  requestedOrganizationId?: string;
  client?: string;
}): Promise<{ status: number; body: any }> {
  const claims = {
    userId: opts.userId,
    client: opts.client ?? "dashboard-agent",
    ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
  };
  const token = await signUserActorToken(SESSION_SECRET, { ...claims, cap: ["read:runs"] });
  mocks.authenticateUserActor.mockImplementation(async () => ({
    ok: true,
    userId: opts.userId,
    claims,
    subject: { type: "userActor", userId: opts.userId },
    ability: buildJwtAbility(["read:runs"]),
  }));

  const query = opts.requestedOrganizationId
    ? `?organizationId=${opts.requestedOrganizationId}`
    : "";
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  const response = await loader({
    request: new Request(`https://api.trigger.dev/api/v1/projects${query}`, { headers }),
    params: {},
    context: {},
  } as any);

  return { status: response.status, body: await response.json() };
}

postgresTest(
  "an org claim narrows the project list to that organization",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const orgA = await seedOrg(prisma);
    // The same user is a member of both orgs, so only the claim can separate them.
    const orgB = await seedOrg(prisma, orgA.user);

    // The shape the dashboard agent mints: the turn's environment plus its organization.
    const minted = {
      userId: orgA.user.id,
      organizationId: orgA.organization.id,
      environmentId: orgA.environment.id,
    };

    const claimed = await callLoader(minted);
    expect(claimed.status).toBe(200);
    expect(claimed.body.map((project: any) => project.externalRef)).toEqual([
      orgA.project.externalRef,
    ]);
    // Org B is a membership of the same user, and the claim is what keeps it out.
    expect(claimed.body.map((project: any) => project.organization.id)).toEqual([
      orgA.organization.id,
    ]);

    // An explicit org that agrees with the claim is fine; one that disagrees is refused
    // rather than overridden.
    const agreeing = await callLoader({
      ...minted,
      requestedOrganizationId: orgA.organization.id,
    });
    expect(agreeing.status).toBe(200);

    const mismatched = await callLoader({
      ...minted,
      requestedOrganizationId: orgB.organization.id,
    });
    expect(mismatched.status).toBe(403);
    expect(mismatched.body.code).toBe("forbidden_environment");

    // No org claim (a personal access token's shape): every membership, as before.
    const claimless = await callLoader({
      userId: orgA.user.id,
      client: "personal-access-token",
    });
    expect(claimless.status).toBe(200);
    expect(claimless.body.map((project: any) => project.externalRef).sort()).toEqual(
      [orgA.project.externalRef, orgB.project.externalRef].sort()
    );
  },
  60_000
);
