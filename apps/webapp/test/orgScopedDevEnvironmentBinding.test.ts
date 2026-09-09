/**
 * An org-scoped user-actor token names no environment, so `dev` has to resolve to the token
 * user's own development environment — never another member's. These drive the real exchange
 * against a real database, then the real reads with the JWT it hands back.
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { signUserActorToken } from "@trigger.dev/rbac";
import { expect, vi } from "vitest";
import * as webappRouteMocks from "./helpers/webappRouteMocks";

const SESSION_SECRET = "test-session-secret-for-org-scoped-dev-binding";

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => webappRouteMocks.dbServerProxyMock(ctx));
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret-for-org-scoped-dev-binding",
    APP_ORIGIN: "https://example.com",
  },
}));
vi.mock("~/services/logger.server", () => webappRouteMocks.loggerMock());
vi.mock("~/services/personalAccessToken.server", () =>
  webappRouteMocks.personalAccessTokenMock({ assertSourcePatActive: true })
);
vi.mock("~/services/tenantContext.server", () =>
  webappRouteMocks.tenantContextMock({ withRun: true })
);
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () =>
  webappRouteMocks.workerGroupTokenServiceMock()
);
vi.mock("~/v3/engineVersion.server", () => ({ determineEngineVersion: async () => "V2" }));
vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    lengthOfQueue: async () => 7,
    lengthOfQueues: async (_env: any, names: string[]) =>
      Object.fromEntries(names.map((name) => [name, 7])),
    currentConcurrencyOfQueue: async () => 2,
    currentConcurrencyOfQueues: async (_env: any, names: string[]) =>
      Object.fromEntries(names.map((name) => [name, 2])),
    getQueueConcurrencyLimit: async () => 5,
    operationalCurrentConcurrencyOfEnvironment: async () => 2,
    getEnvConcurrencyLimit: async () => 10,
    getEnvConcurrencyLimitWithBurstFactor: async () => 10,
    concurrencyOfEnvQueue: async () => 2,
    oldestMessageInQueue: async () => null,
    concurrencyKeyBreakdown: async () => ({ totalBackloggedKeys: 0, keys: [] }),
  },
}));

// The OSS fallback's behaviour: verify the token, build the ability from its own cap.
vi.mock("~/services/rbac.server", async () => {
  const { buildJwtAbility } = await import("@trigger.dev/rbac");
  const webapp = await import("./helpers/webappRouteMocks");

  return {
    rbac: {
      authenticateUserActor: webapp.ossAuthenticateUserActor(SESSION_SECRET),
      authenticatePat: async () => ({ ok: false, status: 401, error: "not a pat" }),
      // The public-JWT branch of the fallback: resolve the environment the JWT names, then
      // compile its own scopes into the ability.
      authenticateBearer: async (request: Request) => {
        const { validatePublicJwtKey } = await import("~/services/realtime/jwtAuth.server");
        const result = await validatePublicJwtKey(webapp.bearerOf(request));
        if (!result.ok) return { ok: false, status: 401, error: result.error };
        return {
          ok: true,
          environment: result.environment,
          subject: { type: "publicJWT" },
          ability: buildJwtAbility((result.claims.scopes as string[]) ?? []),
          jwt: { act: result.claims.act },
        };
      },
    },
  };
});

const { action: jwtAction } = await import("~/routes/api.v1.projects.$projectRef.$env.jwt");
const { loader: queueLoader } = await import("~/routes/api.v1.queues.$queueParam");
const { loader: groundingLoader } =
  await import("~/routes/api.v1.dashboard-agent.queues.$queueParam.grounding");

const QUEUE_NAME = "agent-queue";

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * One org, two members, one project. Each member owns a DEVELOPMENT environment of it; the queue
 * lives only in the token user's.
 */
async function seedWorld(prisma: PrismaClient) {
  const slug = `devbind_${suffix()}`;
  const createUser = (name: string) =>
    prisma.user.create({
      data: { email: `${name}_${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
  const userA = await createUser("a");
  const userB = await createUser("b");

  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const memberA = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: userA.id, role: "ADMIN" },
  });
  const memberB = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: userB.id, role: "MEMBER" },
  });

  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });

  const devFor = (orgMemberId: string) =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: "dev",
        type: "DEVELOPMENT",
        projectId: project.id,
        organizationId: organization.id,
        orgMemberId,
        apiKey: `tr_dev_${suffix()}`,
        pkApiKey: `pk_dev_${suffix()}`,
        shortcode: `d${suffix()}`,
      },
    });

  const devA = await devFor(memberA.id);
  const devB = await devFor(memberB.id);

  await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${suffix()}`,
      name: QUEUE_NAME,
      type: "NAMED",
      projectId: project.id,
      runtimeEnvironmentId: devA.id,
      concurrencyLimit: 5,
      concurrencyLimitBase: 5,
    },
  });

  return { userA, userB, organization, project, devA, devB };
}

function orgScopedToken(userId: string, organizationId: string) {
  return signUserActorToken(SESSION_SECRET, {
    userId,
    client: "dashboard-agent",
    organizationId,
    cap: ["read:queues", "read:query", "read:apiKeys"],
  });
}

async function call(handler: any, url: string, params: Record<string, string>, init?: RequestInit) {
  try {
    const response = await handler({ request: new Request(url, init), params, context: {} });
    return { status: response.status, body: await response.json() };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, body: await thrown.json() };
    }
    throw thrown;
  }
}

function exchangeDevJwt(projectRef: string, token: string) {
  return call(
    jwtAction,
    `https://api.trigger.dev/api/v1/projects/${projectRef}/dev/jwt`,
    { projectRef, env: "dev" },
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    }
  );
}

function withJwt(jwt: string) {
  return { headers: { Authorization: `Bearer ${jwt}` } };
}

postgresTest(
  "an org-scoped token exchanges dev for its own environment, and reads resolve there",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);

    const exchange = await exchangeDevJwt(
      world.project.externalRef,
      await orgScopedToken(world.userA.id, world.organization.id)
    );

    expect(exchange.status).toBe(200);
    expect(exchange.body.environmentId).toBe(world.devA.id);
    expect(exchange.body.environmentId).not.toBe(world.devB.id);

    const jwt = exchange.body.token as string;

    const queue = await call(
      queueLoader,
      `https://api.trigger.dev/api/v1/queues/${QUEUE_NAME}?type=custom`,
      { queueParam: QUEUE_NAME },
      withJwt(jwt)
    );

    expect(queue.status).toBe(200);
    expect(queue.body).toMatchObject({ name: QUEUE_NAME, queued: 7 });

    const grounding = await call(
      groundingLoader,
      `https://api.trigger.dev/api/v1/dashboard-agent/queues/${QUEUE_NAME}/grounding?type=custom`,
      { queueParam: QUEUE_NAME },
      withJwt(jwt)
    );

    expect(grounding.status).toBe(200);
    expect(grounding.body).toMatchObject({ queue: { queued: 7 } });
  },
  60_000
);

postgresTest(
  "the other member's token gets their own dev environment, where the queue isn't",
  async ({ prisma }) => {
    ctx.prisma = prisma;
    const world = await seedWorld(prisma);

    const exchange = await exchangeDevJwt(
      world.project.externalRef,
      await orgScopedToken(world.userB.id, world.organization.id)
    );

    expect(exchange.status).toBe(200);
    expect(exchange.body.environmentId).toBe(world.devB.id);

    const queue = await call(
      queueLoader,
      `https://api.trigger.dev/api/v1/queues/${QUEUE_NAME}?type=custom`,
      { queueParam: QUEUE_NAME },
      withJwt(exchange.body.token as string)
    );

    expect(queue.status).toBe(404);
  },
  60_000
);

postgresTest("a member with no dev environment in the project is refused", async ({ prisma }) => {
  ctx.prisma = prisma;
  const world = await seedWorld(prisma);
  await prisma.runtimeEnvironment.delete({ where: { id: world.devA.id } });

  const exchange = await exchangeDevJwt(
    world.project.externalRef,
    await orgScopedToken(world.userA.id, world.organization.id)
  );

  expect(exchange.status).toBe(404);
});
