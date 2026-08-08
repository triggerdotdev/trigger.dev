/**
 * The boundary a delegated user-actor token has to respect, as one test: it is a first-class
 * credential on the actor-aware routes, which check its claims, and is refused at the entrance
 * of the PAT-only helper, which checks nothing — including the admin gate that helper backs.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken } from "@trigger.dev/rbac";
import { expect, vi } from "vitest";

const SESSION_SECRET = "test-session-secret-for-pat-only-boundary";
const ENCRYPTION_KEY = "12345678901234567890123456789012";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET, ENCRYPTION_KEY },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
// Constructing the real worker opens a Redis connection at import time; nothing on this path
// enqueues (the alert types under test aren't ERROR_GROUP).
vi.mock("~/v3/alertsWorker.server", () => ({
  alertsWorker: { enqueue: vi.fn() },
}));

// The RBAC controller behaves like the OSS fallback: verify the token, ability from its own cap.
vi.mock("~/services/rbac.server", async () => {
  const { buildJwtAbility, verifyUserActorToken } = await import("@trigger.dev/rbac");
  const bearerOf = (request: Request) =>
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim() ?? "";

  return {
    rbac: {
      isUsingPlugin: async () => false,
      authenticateUserActor: async (request: Request, context: any) => {
        const claims = await verifyUserActorToken(
          "test-session-secret-for-pat-only-boundary",
          bearerOf(request)
        );
        if (!claims) return { ok: false, status: 401, error: "Invalid user-actor token" };
        return {
          ok: true,
          userId: claims.userId,
          claims,
          subject: {
            type: "userActor",
            userId: claims.userId,
            organizationId: context.organizationId ?? "",
          },
          ability: buildJwtAbility(claims.cap ?? ["read:all"]),
        };
      },
    },
  };
});

const { loader: listProjectsLoader } = await import("~/routes/api.v1.projects");
const { action: alertChannelsAction } =
  await import("~/routes/api.v1.projects.$projectRef.alertChannels");
const { action: revokedApiKeyAction } =
  await import("~/routes/admin.api.v1.revoked-api-keys.$revokedApiKeyId");

// The cap the dashboard agent mints with (DASHBOARD_AGENT_UAT_CAP) — read scopes only.
const READ_ONLY_CAP = [
  "read:apiKeys",
  "read:runs",
  "read:deployments",
  "read:environments",
  "read:errors",
  "read:query",
];

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** An admin user with an org, a project, a production environment and a revoked API key. */
async function seed(prisma: PrismaClient) {
  const slug = `boundary_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK", admin: true },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: {
      name: slug,
      slug,
      organizationId: organization.id,
      externalRef: `proj_${slug}`,
      version: "V3",
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `prod${suffix()}`,
    },
  });
  const revokedApiKey = await prisma.revokedApiKey.create({
    data: {
      apiKey: `tr_old_${slug}`,
      runtimeEnvironmentId: environment.id,
      expiresAt: new Date("2030-01-01"),
    },
  });

  return { user, organization, project, environment, revokedApiKey };
}

async function call(
  handler: (args: any) => Promise<Response>,
  args: { request: Request; params?: Record<string, string> }
) {
  try {
    const response = await handler({ ...args, params: args.params ?? {}, context: {} });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, body: await thrown.json().catch(() => undefined) };
    }
    throw thrown;
  }
}

function bearer(url: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body === undefined) {
    return new Request(url, { headers });
  }
  headers["Content-Type"] = "application/json";
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Arm 1: an actor-aware read route the agent genuinely calls (its `list_projects` tool). */
function listProjects(token: string) {
  return call(listProjectsLoader, {
    request: bearer("https://api.trigger.dev/api/v1/projects", token),
  });
}

/** Arm 2: a mutation behind the PAT-only helper. */
function createAlertChannel(token: string, projectRef: string) {
  return call(alertChannelsAction, {
    request: bearer(`https://api.trigger.dev/api/v1/projects/${projectRef}/alert-channels`, token, {
      name: "boundary-test",
      channel: "email",
      alertTypes: ["run_failure"],
      channelData: { email: "alerts@example.com" },
    }),
    params: { projectRef },
  });
}

/** Arm 3: an admin mutation behind `requireAdminApiRequest`. */
function extendRevokedApiKey(token: string, revokedApiKeyId: string) {
  return call(revokedApiKeyAction, {
    request: bearer(
      `https://api.trigger.dev/admin/api/v1/revoked-api-keys/${revokedApiKeyId}`,
      token,
      { expiresAt: "2031-01-01T00:00:00.000Z" }
    ),
    params: { revokedApiKeyId },
  });
}

postgresTest(
  "a read-only user-actor token reads through the actor-aware route and is refused by the PAT-only helper",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const seeded = await seed(prisma);
    const token = await signUserActorToken(SESSION_SECRET, {
      userId: seeded.user.id,
      client: "dashboard-agent",
      environmentId: seeded.environment.id,
      cap: READ_ONLY_CAP,
    });

    // Allowed: the route builder checks the claims, and this one is identity-only.
    const read = await listProjects(token);
    expect(read.status).toBe(200);
    expect(read.body.map((project: any) => project.externalRef)).toContain(
      seeded.project.externalRef
    );

    // Refused: the legacy mutation helper checks nothing.
    const mutation = await createAlertChannel(token, seeded.project.externalRef);
    expect(mutation.status).toBe(401);
    expect(
      await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
    ).toBe(0);

    // Refused: the admin gate is the same helper, and the user really is an admin.
    const admin = await extendRevokedApiKey(token, seeded.revokedApiKey.id);
    expect(admin.status).toBe(401);
    expect(
      (await prisma.revokedApiKey.findFirstOrThrow({ where: { id: seeded.revokedApiKey.id } }))
        .expiresAt
    ).toEqual(seeded.revokedApiKey.expiresAt);
  },
  60_000
);

postgresTest(
  "a personal access token still reaches both",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const seeded = await seed(prisma);
    const { createPersonalAccessToken } = await import("~/services/personalAccessToken.server");
    const pat = await createPersonalAccessToken({
      name: "boundary-test",
      userId: seeded.user.id,
    });

    const mutation = await createAlertChannel(pat.token, seeded.project.externalRef);
    expect(mutation.status).toBe(200);
    expect(
      await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
    ).toBe(1);

    const admin = await extendRevokedApiKey(pat.token, seeded.revokedApiKey.id);
    expect(admin.status).toBe(200);
  },
  60_000
);
