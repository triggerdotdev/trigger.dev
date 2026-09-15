import { postgresTest } from "@internal/testcontainers";
import { Prisma, type PrismaClient } from "@trigger.dev/database";
import { buildJwtAbility, signUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { expect, test, vi } from "vitest";
import { createQueue, createRun } from "./helpers/dashboardAgentWorld";
// Imported before `~/services/locateAgentObject.server` below: that import transitively pulls in
// the mocked `~/db.server`, so this binding must already be initialized when that mock factory runs.
import * as webappRouteMocks from "./helpers/webappRouteMocks";
import { MAX_LOCATIONS } from "~/services/locateAgentObject.server";

/** A locationsQueryBuilder stand-in: chainable no-ops, `execute` answers `[null, rows]`. */
function fakeLocationsClickhouse(rows: { environment_id: string; task_identifier: string }[]) {
  const builder: any = {
    where: () => builder,
    groupBy: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    execute: async () => [null, rows],
  };
  return { errors: { locationsQueryBuilder: () => builder } };
}

const SESSION_SECRET = "test-session-secret-for-locate-route";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));
const chFactory = vi.hoisted(() => ({ getClickhouseForOrganization: vi.fn() }));
const authCalls = vi.hoisted(() => ({ authenticatePat: vi.fn(), authenticateUserActor: vi.fn() }));

vi.mock("~/db.server", () => webappRouteMocks.dbServerProxyMock(ctx, Prisma.sql([`public`])));
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: "test-session-secret-for-locate-route" },
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
  clickhouseFactory: chFactory,
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: authCalls.authenticateUserActor,
    authenticatePat: authCalls.authenticatePat,
  },
}));

import { loader } from "~/routes/api.v1.locate.$kind.$id";

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seedOrg(prisma: PrismaClient) {
  const slug = `locate_${suffix()}`;
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
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${suffix()}`,
    },
  });
  return { user, organization, project, environment };
}

function agentToken(userId: string, organizationId: string) {
  return signUserActorToken(SESSION_SECRET, {
    userId,
    client: "dashboard-agent",
    organizationId,
    cap: ["read:runs", "read:deployments", "read:errors", "read:queues"],
  });
}

// The id is decoded here the same way Remix's router decodes a URL param, so a raw encoded id
// in the request URL (e.g. `task%2Fx`) reaches the loader the way it would in production.
function callRoute(kind: string, id: string, authorization?: string) {
  return loader({
    request: new Request(`https://api.trigger.dev/api/v1/locate/${kind}/${id}`, {
      headers: authorization ? { Authorization: authorization } : undefined,
    }),
    params: { kind, id: decodeURIComponent(id) },
    context: {},
  } as any);
}

function bearerOf(request: Request) {
  return (
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim() ?? ""
  );
}

const restrictedUserIds = new Set<string>();

function stubAuth() {
  restrictedUserIds.clear();
  authCalls.authenticateUserActor.mockReset();
  authCalls.authenticatePat.mockReset();
  authCalls.authenticateUserActor.mockImplementation(
    async (request: Request, scope?: { organizationId?: string }) => {
      const claims = await verifyUserActorToken(SESSION_SECRET, bearerOf(request));
      if (!claims) return { ok: false, status: 401, error: "Invalid user-actor token" };
      const cap = claims.cap ?? ["read:all"];
      const floored =
        scope?.organizationId === claims.organizationId && restrictedUserIds.has(claims.userId);
      return {
        ok: true,
        userId: claims.userId,
        claims,
        ability: buildJwtAbility(floored ? cap.filter((entry) => entry !== "read:runs") : cap),
      };
    }
  );
  authCalls.authenticatePat.mockResolvedValue({
    ok: true,
    userId: "usr_pat",
    ability: buildJwtAbility(["admin"]),
    tokenId: "pat_1",
    lastAccessedAt: null,
  });
}

test("refuses a plain PAT, which carries no organization claim at all", async () => {
  stubAuth();

  const response = await callRoute("run", "run_abc", "Bearer pat_test_token");
  const body = await response.json();

  expect(response.status).toBe(403);
  expect(body.code).toBe("forbidden_environment");
  expect(authCalls.authenticateUserActor).not.toHaveBeenCalled();
});

test("rejects a version string for the deployment kind before any auth", async () => {
  stubAuth();

  const response = await callRoute("deployment", "20260101.1");

  expect(response.status).toBe(400);
  expect(authCalls.authenticatePat).not.toHaveBeenCalled();
  expect(authCalls.authenticateUserActor).not.toHaveBeenCalled();
});

postgresTest(
  "locates a run using the organization the token claims, not an unrelated one",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    stubAuth();
    const seeded = await seedOrg(prisma);
    const other = await seedOrg(prisma);
    const friendlyId = await createRun(prisma, seeded.project.id, seeded.environment.id);

    const own = await callRoute(
      "run",
      friendlyId,
      `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`
    );
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      found: true,
      kind: "run",
      id: friendlyId,
      scopes: [
        {
          projectRef: seeded.project.externalRef,
          environmentName: "prod",
          environmentId: seeded.environment.id,
        },
      ],
    });

    const elsewhere = await callRoute(
      "run",
      friendlyId,
      `Bearer ${await agentToken(other.user.id, other.organization.id)}`
    );
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.json()).toEqual({ found: false });
  }
);

postgresTest("reports a malformed error id as 404, not a 500", async ({ prisma }) => {
  ctx.prisma = prisma;
  stubAuth();
  const seeded = await seedOrg(prisma);

  const response = await callRoute(
    "error",
    "error_a_b",
    `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`
  );
  const body = await response.json();

  expect(response.status).toBe(404);
  expect(body).toEqual({ found: false });
});

postgresTest(
  "reports a warehouse-unavailable locate result as 503, but a truncated not-found as 200",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    stubAuth();
    const seeded = await seedOrg(prisma);

    chFactory.getClickhouseForOrganization.mockRejectedValue(new Error("warehouse unavailable"));
    const unavailable = await callRoute(
      "error",
      `error_${suffix()}`,
      `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ found: false, unavailable: true });

    // More rows than the cap, none resolving to a visible environment: a complete miss
    // couldn't be confirmed, so it's a 200 truncated not-found, not a 404.
    const overflowRows = Array.from({ length: MAX_LOCATIONS + 1 }, (_, i) => ({
      environment_id: `env_untracked_${i}`,
      task_identifier: "my-task",
    }));
    chFactory.getClickhouseForOrganization.mockResolvedValue(fakeLocationsClickhouse(overflowRows));
    const truncated = await callRoute(
      "error",
      `error_${suffix()}`,
      `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`
    );

    expect(truncated.status).toBe(200);
    expect(await truncated.json()).toEqual({ found: false, truncated: true });
  }
);

postgresTest(
  "refuses a member whose organization role withholds the capability the token carries",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    stubAuth();
    const seeded = await seedOrg(prisma);
    restrictedUserIds.add(seeded.user.id);
    const friendlyId = await createRun(prisma, seeded.project.id, seeded.environment.id);

    const response = await callRoute(
      "run",
      friendlyId,
      `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("unauthorized");
  }
);

// The queue-found and cross-org-not-found shapes are already proven by `locateAgentObject.test.ts`
// ("finds a queue by name..." / "does not find a queue that only exists in another organization")
// plus this route's own 200/404 shape (the "locates a run..." case above). Only URL decoding, which
// is route-only behaviour, needs its own case here.
postgresTest(
  "decodes a URL-encoded queue name and reports its task queue type",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    stubAuth();
    const seeded = await seedOrg(prisma);
    await createQueue(prisma, seeded.project.id, seeded.environment.id, "task/x");

    const response = await callRoute(
      "queue",
      "task%2Fx",
      `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.id).toBe("task/x");
    expect(body.scopes[0].queueType).toBe("task");
  }
);

postgresTest(
  "rejects an empty queue id and an over-long one before any lookup",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    stubAuth();
    const seeded = await seedOrg(prisma);
    const token = `Bearer ${await agentToken(seeded.user.id, seeded.organization.id)}`;

    const empty = await callRoute("queue", "", token);
    expect(empty.status).toBe(400);

    const tooLong = await callRoute("queue", "a".repeat(201), token);
    expect(tooLong.status).toBe(400);
  }
);
