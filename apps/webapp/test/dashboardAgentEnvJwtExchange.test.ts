/**
 * The env-JWT exchange for the dashboard agent's org-wide delegated token: it mints for the
 * environment the turn is in and for any sibling environment of the same organization, and
 * refuses another organization's environment. Real database, no mocked auth.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";

const SESSION_SECRET = "test-session-secret-for-env-jwt-exchange";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret-for-env-jwt-exchange",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    RBAC_FORCE_FALLBACK: true,
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/authTelemetry.server", () => ({
  authenticateAuthorizeBearerWithTelemetry: vi.fn(),
  authenticateBearerWithTelemetry: vi.fn(),
  observeLegacyBearerAuthentication: vi.fn(),
}));

const { signUserActorToken } = await import("@trigger.dev/rbac");
const { validateJWT } = await import("@trigger.dev/core/v3/jwt");
const { action } = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seedOrg(prisma: PrismaClient) {
  const slug = `envjwt_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const orgMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environmentFor = (envSlug: string, type: "DEVELOPMENT" | "PRODUCTION") =>
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
    user,
    organization,
    project,
    dev: await environmentFor("dev", "DEVELOPMENT"),
    prod: await environmentFor("prod", "PRODUCTION"),
  };
}

async function exchange(opts: {
  token: string;
  projectRef: string;
  env: "dev" | "prod";
}): Promise<Response> {
  const request = new Request(
    `https://example.com/api/v1/projects/${opts.projectRef}/${opts.env}/jwt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({ claims: { scopes: ["read:runs", "read:query"] } }),
    }
  );

  try {
    return await action({
      request,
      params: { projectRef: opts.projectRef, env: opts.env },
      context: {} as any,
    });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function subOf(response: Response, apiKey: string) {
  const { token } = (await response.json()) as { token: string };
  const result = await validateJWT(token, apiKey);
  if (!result.ok) throw new Error("minted token failed validation");
  return result.payload.sub;
}

postgresTest("dashboard agent env JWT exchange", async ({ prisma }) => {
  ctx.prisma = prisma;
  const orgA = await seedOrg(prisma);
  const orgB = await seedOrg(prisma);

  const token = await signUserActorToken(SESSION_SECRET, {
    userId: orgA.user.id,
    client: "dashboard-agent",
    environmentId: orgA.dev.id,
    organizationId: orgA.organization.id,
    cap: ["read:apiKeys", "read:runs", "read:query"],
  });

  // The environment the turn is in.
  const own = await exchange({ token, projectRef: orgA.project.externalRef, env: "dev" });
  expect(own.status).toBe(200);
  expect(await subOf(own, orgA.dev.apiKey)).toBe(orgA.dev.id);

  // A sibling environment of the same organization.
  const sibling = await exchange({ token, projectRef: orgA.project.externalRef, env: "prod" });
  expect(sibling.status).toBe(200);
  expect(await subOf(sibling, orgA.prod.apiKey)).toBe(orgA.prod.id);

  // Another organization's environment.
  const foreign = await exchange({ token, projectRef: orgB.project.externalRef, env: "prod" });
  expect(foreign.status).toBe(404);
});
