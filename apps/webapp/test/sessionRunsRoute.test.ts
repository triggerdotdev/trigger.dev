import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const AUTH = vi.hoisted(() => ({
  userId: "",
  admin: false,
  canReadSessions: true,
  isManagedCloud: true,
}));
const dbHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/db.server", () => {
  const lazy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (!dbHolder.client) throw new Error("dbHolder.client not set for this test");
        return dbHolder.client[prop];
      },
    }
  );
  return { prisma: lazy, $replica: lazy };
});

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      user: { id: AUTH.userId, admin: AUTH.admin, isImpersonating: false },
      ability: {
        can: (action: string, resource: { type: string }) =>
          action === "read" && resource.type === "sessions" && AUTH.canReadSessions,
        canSuper: () => false,
      },
    }),
  },
}));

// Keeps the remix-auth strategy chain from loading; the rbac mock owns the auth outcome.
vi.mock("~/services/session.server", () => ({
  getUserId: async () => AUTH.userId,
  requireUserId: async () => AUTH.userId,
}));

vi.mock("~/features.server", () => ({
  featuresForRequest: () => ({ isManagedCloud: AUTH.isManagedCloud }),
}));

const storeHolder = vi.hoisted(() => ({ store: undefined as any }));
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const value = storeHolder.store[prop];
        return typeof value === "function" ? value.bind(storeHolder.store) : value;
      },
    }
  ),
}));

import { PostgresRunStore } from "@internal/run-store";

const { loader } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.sessions.$sessionParam.runs");

let seq = 0;

async function seed(prisma: PrismaClient, featureFlags: object = { sessionTraceEnabled: true }) {
  dbHolder.client = prisma;
  storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  Object.assign(AUTH, { admin: false, canReadSessions: true, isManagedCloud: true });

  const suffix = `route${seq++}`;
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}`, featureFlags },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const user = async (name: string) => {
    const created = await prisma.user.create({
      data: { email: `${suffix}-${name}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    const member = await prisma.orgMember.create({
      data: { userId: created.id, organizationId: organization.id, role: "ADMIN" },
    });
    return { id: created.id, memberId: member.id };
  };
  const owner = await user("owner");
  const teammate = await user("mate");
  const outsider = await prisma.user.create({
    data: { email: `${suffix}-out@example.com`, authenticationMethod: "MAGIC_LINK" },
  });

  const environment = async (
    slug: string,
    type: "PRODUCTION" | "DEVELOPMENT",
    orgMemberId?: string
  ) =>
    prisma.runtimeEnvironment.create({
      data: {
        type,
        slug,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${suffix}_${slug}`,
        pkApiKey: `pk_${suffix}_${slug}`,
        shortcode: `short_${suffix}_${slug}`,
        orgMemberId,
      },
    });
  const prod = await environment("prod", "PRODUCTION");
  const dev = await environment("dev", "DEVELOPMENT", owner.memberId);

  const session = async (env: { id: string; type: "PRODUCTION" | "DEVELOPMENT" }, id: string) =>
    prisma.session.create({
      data: {
        friendlyId: `session_${suffix}${id}`,
        type: "chat.agent",
        projectId: project.id,
        runtimeEnvironmentId: env.id,
        environmentType: env.type,
        organizationId: organization.id,
        taskIdentifier: "my-chat",
        triggerConfig: { basePayload: {} },
        currentRunVersion: 0,
      },
    });
  const prodSession = await session(prod, "p");
  const devSession = await session(dev, "d");

  const runId = `${suffix}r1`;
  await storeHolder.store.createRun({
    data: {
      id: runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: `run_${runId}`,
      runtimeEnvironmentId: prod.id,
      environmentType: "PRODUCTION",
      organizationId: organization.id,
      projectId: project.id,
      taskIdentifier: "my-chat",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${runId}`,
      spanId: `span_${runId}`,
      runTags: [],
      queue: "task/my-chat",
      isTest: false,
      taskEventStore: "clickhouse_v2",
      depth: 0,
      completedAt: new Date(),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "Run finished",
      runStatus: "COMPLETED_SUCCESSFULLY",
      environmentId: prod.id,
      environmentType: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
    },
  });
  await prisma.sessionRun.create({
    data: { sessionId: prodSession.id, runId, reason: "initial" },
  });

  const call = (
    as: string,
    envSlug: string,
    sessionParam: string,
    query: Record<string, string> = {}
  ) => {
    AUTH.userId = as;
    const params = {
      organizationSlug: organization.slug,
      projectParam: project.slug,
      envParam: envSlug,
      sessionParam,
    };
    const search = new URLSearchParams(query).toString();
    const url = `http://localhost/resources/orgs/${params.organizationSlug}/projects/${params.projectParam}/env/${envSlug}/sessions/${sessionParam}/runs${search ? `?${search}` : ""}`;
    return loader({ request: new Request(url), params, context: {} });
  };

  return { owner, teammate, outsider, prodSession, devSession, runId, call };
}

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Not found" });
}

describe("session runs route", () => {
  postgresTest("returns the page for a member", async ({ prisma }) => {
    const ctx = await seed(prisma);

    const response = await ctx.call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalCount).toBe(1);
    expect(body.data[0]).toMatchObject({ number: 1, friendlyId: `run_${ctx.runId}` });
  });

  postgresTest("a bad cursor is a 400", async ({ prisma }) => {
    const ctx = await seed(prisma);

    // The route builder throws its parse failures as responses.
    const rejected = await ctx
      .call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId, { "page[after]": "not-a-cursor" })
      .catch((thrown: unknown) => thrown);
    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(400);
  });

  postgresTest("run= for a run outside the session is a 404", async ({ prisma }) => {
    const ctx = await seed(prisma);

    await expectNotFound(
      await ctx.call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId, { run: "run_nothere" })
    );
  });

  postgresTest("every access miss is the same 404", async ({ prisma }) => {
    const ctx = await seed(prisma);

    await expectNotFound(await ctx.call(ctx.outsider.id, "prod", ctx.prodSession.friendlyId));
    await expectNotFound(await ctx.call(ctx.teammate.id, "dev", ctx.devSession.friendlyId));
    await expectNotFound(await ctx.call(ctx.owner.id, "dev", ctx.prodSession.friendlyId));

    AUTH.isManagedCloud = false;
    AUTH.admin = true;
    await expectNotFound(await ctx.call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId));
  });

  postgresTest("flag off is a 404 for members but not for admins", async ({ prisma }) => {
    const ctx = await seed(prisma, {});

    await expectNotFound(await ctx.call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId));

    AUTH.admin = true;
    const response = await ctx.call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId);
    expect(response.status).toBe(200);
  });

  postgresTest("a role without read:sessions is denied", async ({ prisma }) => {
    const ctx = await seed(prisma);
    AUTH.canReadSessions = false;

    const denied = await ctx
      .call(ctx.teammate.id, "prod", ctx.prodSession.friendlyId)
      .catch((thrown: unknown) => thrown);
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
  });
});
