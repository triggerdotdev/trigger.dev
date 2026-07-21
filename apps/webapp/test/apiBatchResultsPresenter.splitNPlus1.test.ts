// RED→GREEN: kill the #callSplit per-member N+1 in ApiBatchResultsPresenter.
//
// Today, #callSplit hydrates every batch member independently via `readThroughRun` inside
// `Promise.all(batchRun.items.map(...))` — that is one (up to two, new-then-legacy) `taskRun`
// query PER member. `#callPassthrough` already does the grouped one-query form via
// `this.runStore.findRuns({ where: { id: { in: taskRunIds } } })`.
//
// The fix replaces the per-member fan-out with ONE grouped call to the RunStore's
// `findRunsByIds` method, mirroring `#callPassthrough`. This test proves the query-count
// reduction with a call-counting Proxy over a REAL testcontainer Postgres client: every call is
// delegated unchanged to the real client (the DB still runs the query) — this is instrumentation,
// not a mock.
import { PostgresRunStore } from "@internal/run-store";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";

// 26-char run-ops v1 body: 24-char base32hex core + region char + version "1" at index 25.
// ownerEngine classifies residency by the VERSION CHAR AT INDEX 25, not by length — a naive id
// generator would misclassify this as LEGACY unless the last two chars are a valid region+version.
function newRunId(c: string) {
  return c.repeat(24) + "01";
}

type CallCounts = { findMany: number; findFirst: number };

// Wrap a REAL client's `taskRun` delegate to tally findMany/findFirst calls, delegating every
// call unchanged to the real client (the DB still runs the query — pure instrumentation).
function countingClient(real: PrismaClient): { client: PrismaClient; counts: CallCounts } {
  const counts: CallCounts = { findMany: 0, findFirst: 0 };
  const countingTaskRun = new Proxy((real as any).taskRun, {
    get(target, prop) {
      if (prop === "findMany" || prop === "findFirst") {
        counts[prop as "findMany" | "findFirst"]++;
      }
      return (target as any)[prop];
    },
  });
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "taskRun") {
        return countingTaskRun;
      }
      return (target as any)[prop];
    },
  }) as PrismaClient;
  return { client, counts };
}

let seedCounter = 0;

async function seedEnv(prisma: PrismaClient, slug: string) {
  const n = seedCounter++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${slug}`, slug: `org-${slug}-${n}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Proj ${slug}`,
      slug: `proj-${slug}-${n}`,
      organizationId: organization.id,
      externalRef: `ext-${slug}-${n}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}-${n}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `api-${slug}-${n}`,
      pkApiKey: `pk-${slug}-${n}`,
      shortcode: `sc-${slug}-${n}`,
    },
  });
  return { organization, project, environment };
}

type SeedCtx = Awaited<ReturnType<typeof seedEnv>>;

type MemberSeed = {
  id: string;
  friendlyId: string;
  status: "COMPLETED_SUCCESSFULLY" | "COMPLETED_WITH_ERRORS";
  output?: string;
  error?: unknown;
};

async function seedMember(prisma: PrismaClient, ctx: SeedCtx, m: MemberSeed) {
  const run = await prisma.taskRun.create({
    data: {
      id: m.id,
      friendlyId: m.friendlyId,
      taskIdentifier: "my-task",
      status: m.status,
      payload: JSON.stringify({}),
      payloadType: "application/json",
      traceId: m.id,
      spanId: m.id,
      queue: "main",
      runtimeEnvironmentId: ctx.environment.id,
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
      environmentType: "PRODUCTION",
      engine: "V2",
    },
  });

  await prisma.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${m.id}`,
      number: 1,
      taskRunId: run.id,
      backgroundWorkerId: "bw",
      backgroundWorkerTaskId: "bwt",
      runtimeEnvironmentId: ctx.environment.id,
      queueId: "q",
      status: m.status === "COMPLETED_SUCCESSFULLY" ? "COMPLETED" : "FAILED",
      output: m.output,
      outputType: "application/json",
      error: m.error as any,
    },
  });

  return run;
}

// Drop the TaskRunAttempt worker/queue FKs so attempts can be seeded (their output/error is what's
// under test) without standing up BackgroundWorker/TaskQueue parents — incidental to this read path.
async function relaxFks(prisma: PrismaClient) {
  for (const sql of [
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerId_fkey"`,
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_backgroundWorkerTaskId_fkey"`,
    `ALTER TABLE "TaskRunAttempt" DROP CONSTRAINT IF EXISTS "TaskRunAttempt_queueId_fkey"`,
  ]) {
    await prisma.$executeRawUnsafe(sql);
  }
}

async function seedBatch(
  prisma: PrismaClient,
  ctx: SeedCtx,
  friendlyId: string,
  memberIds: string[]
) {
  const batch = await prisma.batchTaskRun.create({
    data: {
      friendlyId,
      runtimeEnvironmentId: ctx.environment.id,
      runCount: memberIds.length,
      runIds: [],
      batchVersion: "runengine:v2",
    },
  });
  // Items in a deterministic order so the result `items` order is assertable.
  for (const taskRunId of memberIds) {
    await prisma.batchTaskRunItem.create({
      data: { batchTaskRunId: batch.id, taskRunId, status: "COMPLETED" },
    });
  }
  return batch;
}

const env = (ctx: SeedCtx) =>
  ({
    id: ctx.environment.id,
    type: ctx.environment.type,
    slug: ctx.environment.slug,
    organizationId: ctx.organization.id,
    organization: { slug: ctx.organization.slug, title: ctx.organization.title },
    projectId: ctx.project.id,
    project: { name: ctx.project.name },
  }) as unknown as AuthenticatedEnvironment;

describe("ApiBatchResultsPresenter split mode — member hydration is grouped, not per-member", () => {
  postgresTest(
    "a batch of N members costs ONE findMany (never N findFirst) and returns the same result",
    async ({ prisma }) => {
      const ctx = await seedEnv(prisma, "n1");
      await relaxFks(prisma);

      const { client: countingPrisma, counts } = countingClient(prisma);

      const memberIds = [newRunId("a"), newRunId("b"), newRunId("c")];
      await seedMember(prisma, ctx, {
        id: memberIds[0],
        friendlyId: "run_a",
        status: "COMPLETED_SUCCESSFULLY",
        output: JSON.stringify({ from: "a" }),
      });
      await seedMember(prisma, ctx, {
        id: memberIds[1],
        friendlyId: "run_b",
        status: "COMPLETED_WITH_ERRORS",
        error: { type: "BUILT_IN_ERROR", name: "Err", message: "boom", stackTrace: "" },
      });
      await seedMember(prisma, ctx, {
        id: memberIds[2],
        friendlyId: "run_c",
        status: "COMPLETED_SUCCESSFULLY",
        output: JSON.stringify({ from: "c" }),
      });

      await seedBatch(prisma, ctx, "batch_n1", memberIds);

      const runStore = new PostgresRunStore({
        prisma: countingPrisma,
        readOnlyPrisma: countingPrisma,
      });

      const presenter = new ApiBatchResultsPresenter(
        countingPrisma,
        countingPrisma,
        {
          splitEnabled: true,
          newClient: countingPrisma as unknown as PrismaReplicaClient,
          legacyReplica: countingPrisma as unknown as PrismaReplicaClient,
        },
        runStore
      );

      const result = await presenter.call("batch_n1", env(ctx));

      expect(result).toBeDefined();
      expect(result!.id).toBe("batch_n1");
      expect(result!.items).toHaveLength(3);
      expect(result!.items[0]).toEqual({
        ok: true,
        id: "run_a",
        taskIdentifier: "my-task",
        output: JSON.stringify({ from: "a" }),
        outputType: "application/json",
      });
      expect(result!.items[1]).toMatchObject({ ok: false, id: "run_b" });
      expect(result!.items[2]).toEqual({
        ok: true,
        id: "run_c",
        taskIdentifier: "my-task",
        output: JSON.stringify({ from: "c" }),
        outputType: "application/json",
      });

      // The grouped-read proof: ONE findMany for the whole member set, never a findFirst per member.
      expect(counts.findMany).toBe(1);
      expect(counts.findFirst).toBe(0);
    }
  );
});
