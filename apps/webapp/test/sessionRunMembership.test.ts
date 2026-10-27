// A run claim and its SessionRun row commit together, and the paging queries the session runs
// presenter builds on use the (sessionId, triggeredAt, id) index. Real Postgres throughout.

import { postgresTest } from "@internal/testcontainers";
import {
  $transaction as realTransaction,
  type Prisma,
  type PrismaClient,
} from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));

vi.mock("~/services/realtime/v1StreamsGlobal.server", () => ({
  determineRealtimeStreamsVersion: () => "v2",
}));

const triggerState = vi.hoisted(() => ({
  result: undefined as any,
  cancelled: [] as string[],
  // Simulates a lost reply: the transaction commits, then the call throws.
  failAfterCommit: false,
  // Makes the writer read that checks a failed claim throw too.
  failRecoveryRead: false,
}));

vi.mock("~/db.server", () => {
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, {
              get: (_d, method) =>
                triggerState.failRecoveryRead && prop === "sessionRun" && method === "findFirst"
                  ? async () => {
                      throw new Error("Connection terminated unexpectedly");
                    }
                  : holder.client[prop][method],
            });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(primaryHolder, "primaryHolder.client"),
    $transaction: async (
      _client: unknown,
      nameOrFn: unknown,
      fnOrOptions?: unknown,
      options?: unknown
    ) => {
      const result = await realTransaction(
        primaryHolder.client,
        (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as any,
        () => {},
        (typeof nameOrFn === "function" ? fnOrOptions : options) as any
      );
      if (triggerState.failAfterCommit) throw new Error("Connection reset after commit");
      return result;
    },
  };
});

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = storeHolder.store as Record<string | symbol, unknown>;
        if (!store) throw new Error("test bug: storeHolder.store not set before caller ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    async call() {
      return triggerState.result;
    }
  },
}));

vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call(run: { id: string }) {
      triggerState.cancelled.push(run.id);
    }
  },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ensureRunForSession, swapSessionRun } from "~/services/realtime/sessionRunManager.server";
import {
  countSessionRunsAtOrBefore,
  findSessionRunsPage,
  sessionRunsAtOrBeforeCountQuery,
  sessionRunsPageQuery,
} from "~/services/realtime/sessionRunPage.server";

let seq = 0;

const cuidRunId = (suffix: string) => `run_${suffix.padEnd(24, "x").slice(0, 24)}`;

async function seedSession(prisma: PrismaClient, suffix: string, currentRunId?: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  const session = await prisma.session.create({
    data: {
      friendlyId: `session_${suffix}`,
      type: "chat.agent",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      environmentType: "PRODUCTION",
      organizationId: organization.id,
      taskIdentifier: "my-chat",
      triggerConfig: { basePayload: {} },
      currentRunId,
      currentRunVersion: 0,
    },
  });
  return {
    organization,
    project,
    environment,
    session,
    authenticatedEnvironment: {
      id: environment.id,
      organization: { streamBasinName: null },
    } as unknown as AuthenticatedEnvironment,
  };
}

function setup(prisma: PrismaClient) {
  primaryHolder.client = prisma;
  triggerState.cancelled.length = 0;
  triggerState.failAfterCommit = false;
  triggerState.failRecoveryRead = false;
  storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return storeHolder.store as PostgresRunStore;
}

type Seeded = Awaited<ReturnType<typeof seedSession>>;

function createStoredRun(store: PostgresRunStore, seeded: Seeded, id: string, friendlyId: string) {
  return store.createRun({
    data: {
      id,
      engine: "V2",
      status: "EXECUTING",
      friendlyId,
      runtimeEnvironmentId: seeded.environment.id,
      environmentType: "PRODUCTION",
      organizationId: seeded.organization.id,
      projectId: seeded.project.id,
      taskIdentifier: "my-chat",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-chat",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
    snapshot: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Run is executing",
      runStatus: "EXECUTING",
      environmentId: seeded.environment.id,
      environmentType: "PRODUCTION",
      projectId: seeded.project.id,
      organizationId: seeded.organization.id,
    },
  });
}

describe("session run claims record SessionRun", () => {
  postgresTest(
    "ensureRunForSession leaves a row with the run's createdAt as triggeredAt",
    async ({ prisma }) => {
      setup(prisma);
      const suffix = `claim_ensure_${seq++}`;
      const { session, authenticatedEnvironment } = await seedSession(prisma, suffix);
      const runId = cuidRunId(`e${seq}`);
      const createdAt = new Date("2026-10-01T09:59:59.500Z");
      triggerState.result = {
        run: { id: runId, friendlyId: `run_${suffix}`, status: "PENDING", createdAt },
      };

      const result = await ensureRunForSession({
        session,
        environment: authenticatedEnvironment,
        reason: "initial",
      });

      expect(result).toMatchObject({ runId, triggered: true });
      const row = await prisma.sessionRun.findFirst({ where: { runId } });
      expect(row).toMatchObject({ sessionId: session.id, reason: "initial" });
      expect(row?.triggeredAt.toISOString()).toBe(createdAt.toISOString());
    }
  );

  postgresTest("a mollified trigger (no createdAt) records the insert time", async ({ prisma }) => {
    setup(prisma);
    const suffix = `claim_moll_${seq++}`;
    const { session, authenticatedEnvironment } = await seedSession(prisma, suffix);
    const runId = cuidRunId(`m${seq}`);
    triggerState.result = {
      run: { id: runId, friendlyId: `run_${suffix}`, spanId: "" },
      isCached: false,
      isMollified: true,
    };

    const before = Date.now();
    await ensureRunForSession({
      session,
      environment: authenticatedEnvironment,
      reason: "initial",
    });
    const after = Date.now();

    const row = await prisma.sessionRun.findFirst({ where: { runId } });
    expect(row, "no SessionRun row for the mollified run").not.toBeNull();
    // The default may come from the database clock; allow a little skew.
    expect(row!.triggeredAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row!.triggeredAt.getTime()).toBeLessThanOrEqual(after + 1_000);
  });

  postgresTest(
    "a failed SessionRun insert rolls back the claim and cancels the triggered run",
    async ({ prisma }) => {
      const store = setup(prisma);
      const suffix = `claim_rollback_${seq++}`;
      const seeded = await seedSession(prisma, suffix);
      const other = await seedSession(prisma, `${suffix}_other`);
      const runId = cuidRunId(`r${seq}`);
      await createStoredRun(store, seeded, runId, `run_${suffix}`);
      // Another session already holds a row for this run id, so the insert hits a unique violation.
      await prisma.sessionRun.create({
        data: { sessionId: other.session.id, runId, reason: "initial" },
      });
      triggerState.result = {
        run: { id: runId, friendlyId: `run_${suffix}`, status: "PENDING", createdAt: new Date() },
      };

      await expect(
        ensureRunForSession({
          session: seeded.session,
          environment: seeded.authenticatedEnvironment,
          reason: "initial",
        })
      ).rejects.toThrow();

      const session = await prisma.session.findFirst({ where: { id: seeded.session.id } });
      expect(session).toMatchObject({ currentRunId: null, currentRunVersion: 0 });
      expect(await prisma.sessionRun.count({ where: { sessionId: seeded.session.id } })).toBe(0);
      await expect
        .poll(() => triggerState.cancelled, {
          timeout: 5_000,
          message: "the unclaimed run was never cancelled",
        })
        .toContain(runId);
    }
  );

  postgresTest(
    "a lost reply after the claim committed keeps the run instead of cancelling it",
    async ({ prisma }) => {
      const store = setup(prisma);
      const suffix = `claim_lost_reply_${seq++}`;
      const seeded = await seedSession(prisma, suffix);
      const runId = cuidRunId(`l${seq}`);
      await createStoredRun(store, seeded, runId, `run_${suffix}`);
      triggerState.result = {
        run: { id: runId, friendlyId: `run_${suffix}`, status: "PENDING", createdAt: new Date() },
      };
      triggerState.failAfterCommit = true;

      const result = await ensureRunForSession({
        session: seeded.session,
        environment: seeded.authenticatedEnvironment,
        reason: "initial",
      });

      expect(result).toMatchObject({ runId, triggered: true });
      expect(await prisma.sessionRun.count({ where: { runId } })).toBe(1);
      // A cancel is fire-and-forget; give it a few poll intervals to prove it never happens.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(triggerState.cancelled).not.toContain(runId);
    }
  );

  postgresTest(
    "when the check for a committed claim fails too, the run is cancelled and the error rethrown",
    async ({ prisma }) => {
      const store = setup(prisma);
      const suffix = `claim_read_fails_${seq++}`;
      const seeded = await seedSession(prisma, suffix);
      const runId = cuidRunId(`f${seq}`);
      await createStoredRun(store, seeded, runId, `run_${suffix}`);
      triggerState.result = {
        run: { id: runId, friendlyId: `run_${suffix}`, status: "PENDING", createdAt: new Date() },
      };
      triggerState.failAfterCommit = true;
      triggerState.failRecoveryRead = true;

      await expect(
        ensureRunForSession({
          session: seeded.session,
          environment: seeded.authenticatedEnvironment,
          reason: "initial",
        })
      ).rejects.toThrow("Connection reset after commit");

      await expect
        .poll(() => triggerState.cancelled, {
          timeout: 5_000,
          message: "the run was not cancelled when the claim could not be checked",
        })
        .toContain(runId);
    }
  );

  postgresTest(
    "a failed SessionRun insert on swap keeps the calling run and cancels the new one",
    async ({ prisma }) => {
      const store = setup(prisma);
      const suffix = `swap_rollback_${seq++}`;
      const callingRunId = cuidRunId(`s${seq}`);
      const seeded = await seedSession(prisma, suffix, callingRunId);
      const other = await seedSession(prisma, `${suffix}_other`);
      await createStoredRun(store, seeded, callingRunId, `run_${suffix}_calling`);
      const newRunId = cuidRunId(`w${seq}`);
      await createStoredRun(store, seeded, newRunId, `run_${suffix}_new`);
      await prisma.sessionRun.create({
        data: { sessionId: other.session.id, runId: newRunId, reason: "initial" },
      });
      triggerState.result = {
        run: {
          id: newRunId,
          friendlyId: `run_${suffix}_new`,
          status: "PENDING",
          createdAt: new Date(),
        },
      };

      await expect(
        swapSessionRun({
          session: seeded.session,
          callingRunId,
          environment: seeded.authenticatedEnvironment,
          reason: "manual",
        })
      ).rejects.toThrow();

      const session = await prisma.session.findFirst({ where: { id: seeded.session.id } });
      expect(session).toMatchObject({ currentRunId: callingRunId, currentRunVersion: 0 });
      await expect
        .poll(() => triggerState.cancelled, {
          timeout: 5_000,
          message: "the new run was never cancelled after the swap rolled back",
        })
        .toContain(newRunId);
    }
  );

  postgresTest("swapSessionRun leaves a row for the new run", async ({ prisma }) => {
    const store = setup(prisma);
    const suffix = `claim_swap_${seq++}`;
    const callingRunId = cuidRunId(`c${seq}`);
    const seeded = await seedSession(prisma, suffix, callingRunId);
    await createStoredRun(store, seeded, callingRunId, `run_${suffix}_calling`);
    const newRunId = cuidRunId(`n${seq}`);
    const createdAt = new Date("2026-10-02T12:00:00.000Z");
    triggerState.result = {
      run: { id: newRunId, friendlyId: `run_${suffix}_new`, status: "PENDING", createdAt },
    };

    const result = await swapSessionRun({
      session: seeded.session,
      callingRunId,
      environment: seeded.authenticatedEnvironment,
      reason: "manual",
    });

    expect(result).toMatchObject({ runId: newRunId, swapped: true });
    const row = await prisma.sessionRun.findFirst({ where: { runId: newRunId } });
    expect(row).toMatchObject({ sessionId: seeded.session.id, reason: "manual" });
    expect(row?.triggeredAt.toISOString()).toBe(createdAt.toISOString());
  });
});

describe("session run paging queries", () => {
  async function seedRuns(prisma: PrismaClient, sessionId: string, times: string[]) {
    for (const [i, t] of times.entries()) {
      await prisma.sessionRun.create({
        data: {
          sessionId,
          runId: `${sessionId}_run_${i}`,
          reason: "continuation",
          triggeredAt: new Date(t),
        },
      });
    }
  }

  postgresTest(
    "pages newest first by (triggeredAt, id) and counts rows at or before",
    async ({ prisma }) => {
      const { session } = await seedSession(prisma, `page_${seq++}`);
      // Two runs share a millisecond, so the id decides their order.
      await seedRuns(prisma, session.id, [
        "2026-10-01T10:00:00.000Z",
        "2026-10-01T11:00:00.000Z",
        "2026-10-01T11:00:00.000Z",
        "2026-10-01T12:00:00.000Z",
        "2026-10-01T13:00:00.000Z",
      ]);
      const expected = await prisma.sessionRun.findMany({
        where: { sessionId: session.id },
        orderBy: [{ triggeredAt: "desc" }, { id: "desc" }],
      });

      const first = await findSessionRunsPage(prisma, { sessionId: session.id, take: 2 });
      const second = await findSessionRunsPage(prisma, {
        sessionId: session.id,
        before: first.at(-1)!,
        take: 2,
      });
      const third = await findSessionRunsPage(prisma, {
        sessionId: session.id,
        before: second.at(-1)!,
        take: 2,
      });

      expect([...first, ...second, ...third].map((r) => r.id)).toEqual(expected.map((r) => r.id));
      expect(first[0].triggeredAt).toBeInstanceOf(Date);
      expect(third).toHaveLength(1);

      // Run numbers count up from the oldest: the newest row is run 5, the second page's oldest is 2.
      expect(
        await countSessionRunsAtOrBefore(prisma, { sessionId: session.id, cursor: first[0] })
      ).toBe(5);
      expect(
        await countSessionRunsAtOrBefore(prisma, { sessionId: session.id, cursor: second.at(-1)! })
      ).toBe(2);

      // A deep link's page starts at the linked row itself.
      const fromSecond = await findSessionRunsPage(prisma, {
        sessionId: session.id,
        atOrBefore: second[0],
        take: 2,
      });
      expect(fromSecond.map((r) => r.id)).toEqual(second.map((r) => r.id));
    }
  );

  postgresTest("all queries use the (sessionId, triggeredAt, id) index", async ({ prisma }) => {
    const { session } = await seedSession(prisma, `explain_${seq++}`);
    const other = await seedSession(prisma, `explain_other_${seq++}`);
    await prisma.$executeRaw`
      INSERT INTO "SessionRun" (id, "sessionId", "runId", reason, "triggeredAt")
      SELECT 'sr_' || s.sid || '_' || g, s.sid, 'run_' || s.sid || '_' || g, 'continuation',
             timestamp '2026-10-01' + g * interval '1 minute'
      FROM generate_series(1, 2000) g
      CROSS JOIN (VALUES (${session.id}), (${other.session.id})) AS s(sid)`;
    await prisma.$executeRaw`ANALYZE "SessionRun"`;
    const cursor = { triggeredAt: new Date("2026-10-01T10:00:00.000Z"), id: "sr_x" };

    const plans = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const explain = async (query: Prisma.Sql) =>
        (await tx.$queryRaw<{ "QUERY PLAN": string }[]>`EXPLAIN ${query}`)
          .map((r) => r["QUERY PLAN"])
          .join("\n");
      return {
        newest: await explain(sessionRunsPageQuery({ sessionId: session.id, take: 21 })),
        older: await explain(
          sessionRunsPageQuery({ sessionId: session.id, before: cursor, take: 21 })
        ),
        atOrBefore: await explain(
          sessionRunsPageQuery({ sessionId: session.id, atOrBefore: cursor, take: 21 })
        ),
        count: await explain(sessionRunsAtOrBeforeCountQuery({ sessionId: session.id, cursor })),
      };
    });

    for (const [name, plan] of Object.entries(plans)) {
      expect(plan, `${name} query plan:\n${plan}`).toContain(
        "SessionRun_sessionId_triggeredAt_id_idx"
      );
      expect(plan, `${name} query plan sorts:\n${plan}`).not.toMatch(/\bSort\b/);
    }
  });
});
