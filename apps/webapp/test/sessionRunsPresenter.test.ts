import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";

import { PostgresRunStore } from "@internal/run-store";
import {
  SessionRunsPresenter,
  SessionRunsSearchParams,
  sessionRunSelect,
  type SessionRunsPresenterDeps,
} from "~/presenters/v3/SessionRunsPresenter.server";
import { runTraceUnavailableBeforeRead } from "~/presenters/v3/runTraceSetup.server";
import { findSessionForRunsView } from "~/presenters/v3/sessionRunsAccess.server";
import {
  decodeSessionRunCursor,
  encodeSessionRunCursor,
} from "~/services/realtime/sessionRunPage.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let seq = 0;

async function seedOrg(prisma: PrismaClient, suffix: string, featureFlags?: object) {
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
  return { organization, project };
}

async function seedEnvironment(
  prisma: PrismaClient,
  seeded: Awaited<ReturnType<typeof seedOrg>>,
  slug: string,
  options: { type?: "PRODUCTION" | "DEVELOPMENT"; orgMemberId?: string } = {}
) {
  const suffix = `${seeded.project.slug}-${slug}`;
  return prisma.runtimeEnvironment.create({
    data: {
      type: options.type ?? "PRODUCTION",
      slug,
      projectId: seeded.project.id,
      organizationId: seeded.organization.id,
      apiKey: `tr_${suffix}`,
      pkApiKey: `pk_${suffix}`,
      shortcode: `short_${suffix}`,
      orgMemberId: options.orgMemberId,
    },
  });
}

async function seedSession(
  prisma: PrismaClient,
  seeded: Awaited<ReturnType<typeof seedOrg>>,
  environment: { id: string; type: "PRODUCTION" | "DEVELOPMENT" | "STAGING" | "PREVIEW" },
  friendlyId: string
) {
  return prisma.session.create({
    data: {
      friendlyId,
      type: "chat.agent",
      projectId: seeded.project.id,
      runtimeEnvironmentId: environment.id,
      environmentType: environment.type,
      organizationId: seeded.organization.id,
      taskIdentifier: "my-chat",
      triggerConfig: { basePayload: {} },
      currentRunVersion: 0,
    },
  });
}

async function seedMember(prisma: PrismaClient, organizationId: string, suffix: string) {
  const user = await prisma.user.create({
    data: { email: `${suffix}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const member = await prisma.orgMember.create({
    data: { userId: user.id, organizationId, role: "ADMIN" },
  });
  return { user, member };
}

type RunOverrides = {
  status?: TaskRunStatus;
  completedAt?: Date | null;
  updatedAt?: Date;
  logsDeletedAt?: Date | null;
  taskEventStore?: string;
  environmentId?: string;
};

async function createRun(
  prisma: PrismaClient,
  store: PostgresRunStore,
  seeded: Awaited<ReturnType<typeof seedOrg>>,
  environmentId: string,
  id: string,
  overrides: RunOverrides = {}
) {
  const runEnvironmentId = overrides.environmentId ?? environmentId;
  await store.createRun({
    data: {
      id,
      engine: "V2",
      status: overrides.status ?? "COMPLETED_SUCCESSFULLY",
      friendlyId: `run_${id}`,
      runtimeEnvironmentId: runEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      taskIdentifier: "my-chat",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${id}`,
      spanId: `span_${id}`,
      runTags: [],
      queue: "task/my-chat",
      isTest: false,
      taskEventStore: overrides.taskEventStore ?? "clickhouse_v2",
      depth: 0,
      completedAt: overrides.completedAt === undefined ? new Date() : overrides.completedAt,
      logsDeletedAt: overrides.logsDeletedAt ?? null,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "Run finished",
      runStatus: overrides.status ?? "COMPLETED_SUCCESSFULLY",
      environmentId: runEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: seeded.project.id,
      organizationId: seeded.organization.id,
    },
  });
  if (overrides.updatedAt) {
    await prisma.$executeRaw`UPDATE "TaskRun" SET "updatedAt" = ${overrides.updatedAt} WHERE id = ${id}`;
  }
}

// Session with `count` runs triggered a minute apart; run N has id `<prefix>rN`.
async function seedSessionWithRuns(
  prisma: PrismaClient,
  count: number,
  runOverrides: (n: number) => RunOverrides = () => ({})
) {
  const suffix = `sr${seq++}`;
  const seeded = await seedOrg(prisma, suffix, { sessionTraceEnabled: true });
  const environment = await seedEnvironment(prisma, seeded, "prod");
  const session = await seedSession(prisma, seeded, environment, `session_${suffix}`);
  const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const base = Date.parse("2026-10-01T00:00:00.000Z");

  for (let n = 1; n <= count; n++) {
    await addRun(n, runOverrides(n));
  }

  async function addRun(n: number, overrides: RunOverrides = {}) {
    const runId = `${suffix}r${n}`;
    await createRun(prisma, store, seeded, environment.id, runId, overrides);
    await prisma.sessionRun.create({
      data: {
        sessionId: session.id,
        runId,
        reason: n === 1 ? "initial" : "continuation",
        triggeredAt: new Date(base + n * 60_000),
      },
    });
  }

  const deps: SessionRunsPresenterDeps = {
    replica: prisma,
    findRunsByIds: (ids) => store.findRunsByIds(ids, { select: sessionRunSelect }, prisma),
    unavailableBeforeRead: runTraceUnavailableBeforeRead,
    emergencySpanCap: undefined,
    v1RerouteEnabled: true,
  };

  const query = {
    session: {
      id: session.id,
      projectId: session.projectId,
      runtimeEnvironmentId: session.runtimeEnvironmentId,
    },
    pageSize: 20,
    showDeletedLogs: false,
  };

  return { prisma, seeded, environment, session, store, suffix, addRun, deps, query };
}

describe("SessionRunsPresenter", () => {
  postgresTest("pages newest first with stable run numbers", async ({ prisma }) => {
    const { deps, query, suffix } = await seedSessionWithRuns(prisma, 23);
    const presenter = new SessionRunsPresenter(deps);

    const first = await presenter.call(query);
    expect(first?.totalCount).toBe(23);
    expect(first?.data.map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, i) => 23 - i));
    expect(first?.data[0]?.friendlyId).toBe(`run_${suffix}r23`);
    expect(first?.pagination.next).toBeDefined();

    const second = await presenter.call({
      ...query,
      after: decodeSessionRunCursor(first!.pagination.next!),
    });
    expect(second?.data.map((r) => r.number)).toEqual([3, 2, 1]);
    expect(second?.data.at(-1)?.reason).toBe("initial");
    expect(second?.pagination.next).toBeUndefined();
  });

  postgresTest("an appended run doesn't shift an earlier page's numbers", async ({ prisma }) => {
    const { deps, query, addRun } = await seedSessionWithRuns(prisma, 23);
    const presenter = new SessionRunsPresenter(deps);
    const first = await presenter.call(query);
    const after = decodeSessionRunCursor(first!.pagination.next!);

    await addRun(24);

    const second = await presenter.call({ ...query, after });
    expect(second?.data.map((r) => r.number)).toEqual([3, 2, 1]);
    expect(second?.totalCount).toBe(24);
  });

  postgresTest(
    "a run added after the page read doesn't change the newest page's total",
    async ({ prisma }) => {
      const { deps, query, addRun } = await seedSessionWithRuns(prisma, 23);
      // A run is triggered right after the page rows are read, and any other read waits for it:
      // a count would then see 24 runs while the rows end at 23.
      let runAdded!: () => void;
      const added = new Promise<void>((resolve) => (runAdded = resolve));
      const replica = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "$queryRaw") return Reflect.get(target, prop, receiver);
          return async (sql: { sql: string }, ...values: unknown[]) => {
            if (!sql.sql.includes("LIMIT")) {
              await added;
              return target.$queryRaw(sql as never, ...values);
            }
            const rows = await target.$queryRaw(sql as never, ...values);
            await addRun(24);
            runAdded();
            return rows;
          };
        },
      });

      const page = await new SessionRunsPresenter({ ...deps, replica }).call(query);
      expect(page?.data[0]?.number).toBe(23);
      expect(page?.totalCount).toBe(23);
    }
  );

  postgresTest("afterCrash sees a crashed run on the previous page", async ({ prisma }) => {
    const { deps, query } = await seedSessionWithRuns(prisma, 23, (n) =>
      n === 3 ? { status: "CRASHED" } : {}
    );
    const page = await new SessionRunsPresenter(deps).call(query);

    const oldest = page?.data.at(-1);
    expect(oldest?.number).toBe(4);
    expect(oldest?.afterCrash).toBe(true);
    expect(page?.data.filter((r) => r.afterCrash)).toHaveLength(1);
  });

  postgresTest("a missing run keeps its friendlyId and number", async ({ prisma }) => {
    const ctx = await seedSessionWithRuns(prisma, 2);
    await ctx.prisma.sessionRun.create({
      data: {
        sessionId: ctx.session.id,
        runId: "missingrun1",
        reason: "continuation",
        triggeredAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    });

    const page = await new SessionRunsPresenter(ctx.deps).call(ctx.query);
    expect(page?.data[0]).toMatchObject({
      number: 3,
      friendlyId: "run_missingrun1",
      status: null,
      createdAt: null,
      finishedAt: null,
      afterCrash: false,
    });
    expect(page?.view).not.toHaveProperty("run_missingrun1");
  });

  postgresTest("a run in another environment is dropped as missing", async ({ prisma }) => {
    const ctx = await seedSessionWithRuns(prisma, 1);
    const other = await seedEnvironment(prisma, ctx.seeded, "staging");
    await createRun(prisma, ctx.store, ctx.seeded, other.id, `${ctx.suffix}foreign`);
    await prisma.sessionRun.create({
      data: {
        sessionId: ctx.session.id,
        runId: `${ctx.suffix}foreign`,
        reason: "continuation",
        triggeredAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    });

    const page = await new SessionRunsPresenter(ctx.deps).call(ctx.query);
    expect(page?.data[0]).toMatchObject({ number: 2, status: null });
    expect(Object.keys(page!.view)).toEqual([`run_${ctx.suffix}r1`]);
  });

  postgresTest("a CANCELED run without completedAt finishes at updatedAt", async ({ prisma }) => {
    const updatedAt = new Date("2026-10-05T12:00:00.000Z");
    const { deps, query } = await seedSessionWithRuns(prisma, 1, () => ({
      status: "CANCELED",
      completedAt: null,
      updatedAt,
    }));
    const page = await new SessionRunsPresenter(deps).call(query);

    expect(page?.data[0]).toMatchObject({
      status: "CANCELED",
      completedAt: null,
      finishedAt: updatedAt.toISOString(),
    });
  });

  postgresTest("view.unavailable reports why a run can't load here", async ({ prisma }) => {
    const ctx = await seedSessionWithRuns(prisma, 3, (n) =>
      n === 1 ? { logsDeletedAt: new Date() } : n === 2 ? { taskEventStore: "taskEvent" } : {}
    );
    const presenter = new SessionRunsPresenter(ctx.deps);
    const r = (n: number) => `run_${ctx.suffix}r${n}`;

    const s = (n: number) => `span_${ctx.suffix}r${n}`;

    const page = await presenter.call(ctx.query);
    expect(page?.view).toEqual({
      [r(1)]: { spanId: s(1), unavailable: "logsDeleted" },
      [r(2)]: { spanId: s(2), unavailable: "legacyStore" },
      [r(3)]: { spanId: s(3) },
    });

    const impersonating = await presenter.call({ ...ctx.query, showDeletedLogs: true });
    expect(impersonating?.view[r(1)]).toEqual({ spanId: s(1) });

    const capped = await new SessionRunsPresenter({ ...ctx.deps, emergencySpanCap: 1000 }).call(
      ctx.query
    );
    expect(capped?.view[r(3)]).toEqual({ spanId: s(3), unavailable: "emergencyCap" });
  });

  postgresTest("a v1-store run loads only while the v1 reroute is on", async ({ prisma }) => {
    const ctx = await seedSessionWithRuns(prisma, 1, () => ({ taskEventStore: "clickhouse" }));
    const r1 = `run_${ctx.suffix}r1`;

    const rerouted = await new SessionRunsPresenter(ctx.deps).call(ctx.query);
    expect(rerouted?.view[r1]).toEqual({ spanId: `span_${ctx.suffix}r1` });

    const notRerouted = await new SessionRunsPresenter({
      ...ctx.deps,
      v1RerouteEnabled: false,
    }).call(ctx.query);
    expect(notRerouted?.view[r1]).toEqual({
      spanId: `span_${ctx.suffix}r1`,
      unavailable: "legacyStore",
    });
  });

  postgresTest("run= returns the page ending at that run", async ({ prisma }) => {
    const ctx = await seedSessionWithRuns(prisma, 50);
    const presenter = new SessionRunsPresenter(ctx.deps);

    const page = await presenter.call({ ...ctx.query, runFriendlyId: `run_${ctx.suffix}r23` });
    expect(page?.data.map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, i) => 23 - i));
    expect(page?.totalCount).toBe(50);

    const earlier = await presenter.call({
      ...ctx.query,
      after: decodeSessionRunCursor(page!.pagination.next!),
    });
    expect(earlier?.data.map((r) => r.number)).toEqual([3, 2, 1]);
  });

  postgresTest("run= for a run outside the session returns null", async ({ prisma }) => {
    const ctx = await seedSessionWithRuns(prisma, 2);
    const other = await seedSessionWithRuns(prisma, 1);

    const page = await new SessionRunsPresenter(ctx.deps).call({
      ...ctx.query,
      runFriendlyId: `run_${other.suffix}r1`,
    });
    expect(page).toBeNull();
  });

  postgresTest("an empty session returns no runs", async ({ prisma }) => {
    const { deps, query } = await seedSessionWithRuns(prisma, 0);
    const page = await new SessionRunsPresenter(deps).call(query);
    expect(page).toEqual({ data: [], pagination: {}, totalCount: 0, view: {} });
  });
});

describe("findSessionForRunsView", () => {
  async function seedAccess(prisma: PrismaClient, featureFlags?: object) {
    const suffix = `ac${seq++}`;
    const seeded = await seedOrg(prisma, suffix, featureFlags);
    const owner = await seedMember(prisma, seeded.organization.id, `${suffix}-owner`);
    const teammate = await seedMember(prisma, seeded.organization.id, `${suffix}-mate`);
    const prod = await seedEnvironment(prisma, seeded, "prod");
    const dev = await seedEnvironment(prisma, seeded, "dev", {
      type: "DEVELOPMENT",
      orgMemberId: owner.member.id,
    });
    const prodSession = await seedSession(prisma, seeded, prod, `session_${suffix}p`);
    const devSession = await seedSession(prisma, seeded, dev, `session_${suffix}d`);
    const outsider = await prisma.user.create({
      data: { email: `${suffix}-out@example.com`, authenticationMethod: "MAGIC_LINK" },
    });

    const request = (
      userId: string,
      environmentSlug: string,
      sessionParam: string,
      isAdmin = false,
      isManagedCloud = true
    ) =>
      findSessionForRunsView({
        organizationSlug: seeded.organization.slug,
        projectSlug: seeded.project.slug,
        environmentSlug,
        sessionParam,
        userId,
        isAdmin,
        isManagedCloud,
        db: prisma,
      });

    return { owner, teammate, outsider, prodSession, devSession, request };
  }

  postgresTest(
    "members see the session; outsiders and other environments don't",
    async ({ prisma }) => {
      const ctx = await seedAccess(prisma, { sessionTraceEnabled: true });

      expect(
        await ctx.request(ctx.teammate.user.id, "prod", ctx.prodSession.friendlyId)
      ).toMatchObject({
        ok: true,
      });
      expect(await ctx.request(ctx.outsider.id, "prod", ctx.prodSession.friendlyId)).toEqual({
        ok: false,
        error: "Project not found",
      });
      expect(await ctx.request(ctx.owner.user.id, "dev", ctx.prodSession.friendlyId)).toEqual({
        ok: false,
        error: "Session not found",
      });
    }
  );

  postgresTest("a dev session is visible to its owner only", async ({ prisma }) => {
    const ctx = await seedAccess(prisma, { sessionTraceEnabled: true });

    expect(await ctx.request(ctx.owner.user.id, "dev", ctx.devSession.friendlyId)).toMatchObject({
      ok: true,
    });
    expect(await ctx.request(ctx.teammate.user.id, "dev", ctx.devSession.friendlyId)).toEqual({
      ok: false,
      error: "Environment not found",
    });
  });

  postgresTest("flag off hides it from members but not from admins", async ({ prisma }) => {
    const ctx = await seedAccess(prisma);

    expect(await ctx.request(ctx.teammate.user.id, "prod", ctx.prodSession.friendlyId)).toEqual({
      ok: false,
      error: "Not found",
    });
    expect(
      await ctx.request(ctx.teammate.user.id, "prod", ctx.prodSession.friendlyId, true)
    ).toMatchObject({ ok: true });
  });

  postgresTest("self-hosted instances never see it, even with the flag on", async ({ prisma }) => {
    const ctx = await seedAccess(prisma, { sessionTraceEnabled: true });
    const selfHosted = (isAdmin: boolean) =>
      ctx.request(ctx.teammate.user.id, "prod", ctx.prodSession.friendlyId, isAdmin, false);

    expect(await selfHosted(false)).toEqual({ ok: false, error: "Not found" });
    expect(await selfHosted(true)).toEqual({ ok: false, error: "Not found" });
  });
});

describe("SessionRunsSearchParams", () => {
  const cursor = { triggeredAt: new Date("2026-10-01T00:01:00.123Z"), id: "clxsessionrun1" };

  it("round-trips a cursor", () => {
    expect(decodeSessionRunCursor(encodeSessionRunCursor(cursor))).toEqual(cursor);
  });

  it("rejects a bad cursor, a bad run ID and both together", () => {
    expect(SessionRunsSearchParams.safeParse({ "page[after]": "not-a-cursor" }).success).toBe(
      false
    );
    expect(
      SessionRunsSearchParams.safeParse({
        "page[after]": Buffer.from(JSON.stringify({ t: "yesterday", id: "x" })).toString(
          "base64url"
        ),
      }).success
    ).toBe(false);
    expect(SessionRunsSearchParams.safeParse({ run: "run_a_b" }).success).toBe(false);
    expect(
      SessionRunsSearchParams.safeParse({
        "page[after]": encodeSessionRunCursor(cursor),
        run: "run_abc",
      }).success
    ).toBe(false);
  });

  it("defaults the page size to 20 and caps it at 100", () => {
    expect(SessionRunsSearchParams.parse({})["page[size]"]).toBe(20);
    expect(SessionRunsSearchParams.safeParse({ "page[size]": "101" }).success).toBe(false);
  });
});
