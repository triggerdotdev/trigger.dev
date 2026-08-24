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

const SESSION_SECRET = "test-session-secret-for-project-wide-scope";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  patUserId: undefined as string | undefined,
  presenterEnvironments: [] as Array<{ id: string; organizationId: string } | undefined>,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: "test-session-secret-for-project-wide-scope" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/personalAccessToken.server", () => ({
  updateLastAccessedAtIfStale: vi.fn(),
  // The plugin already verified the claims; test tokens carry no source PAT, so the
  // liveness recheck is a no-op that hands the claims straight back.
  resolveAndRecheckUserActorClaims: async (claims: unknown) => claims,
}));
vi.mock("~/services/authTelemetry.server", () => ({
  authenticateBearerWithTelemetry: vi.fn(),
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
  const { buildJwtAbility, verifyUserActorToken } = await import("@trigger.dev/rbac");
  const bearerOf = (request: Request) =>
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim() ?? "";

  return {
    rbac: {
      authenticateUserActor: async (request: Request, context: any) => {
        const claims = await verifyUserActorToken(
          "test-session-secret-for-project-wide-scope",
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

function agentToken(userId: string, environmentId?: string, client = "dashboard-agent") {
  return signUserActorToken(SESSION_SECRET, {
    userId,
    client,
    ...(environmentId ? { environmentId } : {}),
    cap: ["read:runs", "read:environments"],
  });
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

postgresTest(
  "a user-actor token scoped to one environment lists only that environment",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const seeded = await seedProject(prisma);
    ctx.patUserId = seeded.user.id;

    const scoped = await call(environmentsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, seeded.envA.id),
    });

    expect(scoped.status).toBe(200);
    expect(scoped.body.map((env: any) => env.id)).toEqual([seeded.envA.id]);
  },
  60_000
);

postgresTest(
  "a user-actor token sees only its own environment's runs",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    ctx.presenterEnvironments = [];
    const seeded = await seedProject(prisma);
    ctx.patUserId = seeded.user.id;

    const scoped = await call(runsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, seeded.envA.id),
    });

    expect(scoped.status).toBe(200);
    expect(ctx.presenterEnvironments).toEqual([
      { id: seeded.envA.id, organizationId: seeded.organization.id },
    ]);
  },
  60_000
);

postgresTest(
  "a user-actor token asking for another environment is refused, not overridden",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    ctx.presenterEnvironments = [];
    const seeded = await seedProject(prisma);
    ctx.patUserId = seeded.user.id;

    const conflicting = await call(runsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, seeded.envA.id),
      search: `?filter[env]=${seeded.envB.slug}`,
    });

    expect(conflicting.status).toBe(403);
    expect(conflicting.body.code).toBe("forbidden_environment");
    expect(ctx.presenterEnvironments).toEqual([]);
  },
  60_000
);

postgresTest(
  "a claimless dashboard-agent token is refused",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const seeded = await seedProject(prisma);
    ctx.patUserId = seeded.user.id;

    // The agent always mints per-environment, so a claimless one of its own is a bug, not a flow.
    const claimless = await call(environmentsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, undefined),
    });

    expect(claimless.status).toBe(403);
    expect(claimless.body.code).toBe("forbidden_environment");
  },
  60_000
);

postgresTest(
  "a claimless user-actor token from another client still gets the project-wide answer",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    ctx.presenterEnvironments = [];
    const seeded = await seedProject(prisma);
    ctx.patUserId = seeded.user.id;

    // The public PAT exchange mints claimless tokens, so narrowing one would be a breaking
    // change: it reads the whole project as it always has.
    const environments = await call(environmentsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, undefined, "mcp"),
    });

    expect(environments.status).toBe(200);
    expect(environments.body.map((env: any) => env.id).sort()).toEqual(
      [seeded.envA.id, seeded.envB.id].sort()
    );

    const runs = await call(runsLoader, {
      projectRef: seeded.project.externalRef,
      token: await agentToken(seeded.user.id, undefined, "mcp"),
      search: `?filter[env]=${seeded.envB.slug}`,
    });

    // No forced environment, and its own filter is honoured rather than refused.
    expect(runs.status).toBe(200);
    expect(ctx.presenterEnvironments).toEqual([undefined]);
  },
  60_000
);

postgresTest(
  "a personal access token still gets the project-wide answer",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    ctx.presenterEnvironments = [];
    const seeded = await seedProject(prisma);
    ctx.patUserId = seeded.user.id;

    const environments = await call(environmentsLoader, {
      projectRef: seeded.project.externalRef,
      token: PAT,
    });

    expect(environments.status).toBe(200);
    expect(environments.body.map((env: any) => env.id).sort()).toEqual(
      [seeded.envA.id, seeded.envB.id].sort()
    );

    const runs = await call(runsLoader, {
      projectRef: seeded.project.externalRef,
      token: PAT,
      search: `?filter[env]=${seeded.envB.slug}`,
    });

    // No forced environment: the request's own filter decides, as before.
    expect(runs.status).toBe(200);
    expect(ctx.presenterEnvironments).toEqual([undefined]);
  },
  60_000
);
