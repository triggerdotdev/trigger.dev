// Read-through proof for ApiBatchResultsPresenter.
//
// The batch row + its item rows resolve new-run-ops-first then off the LEGACY run-ops READ
// REPLICA ONLY; each member run is hydrated independently via the per-run read-through primitive,
// so a batch whose members span migrated (NEW) + abandoned (LEGACY) runs returns the
// complete reachable set. Single-DB collapses to one passthrough read. We NEVER mock the DB — the
// only injected fakes are the pure boundaries (splitEnabled / isPastRetention).
//
// The BatchTaskRunItem -> TaskRun FK is per-DB; a batch straddling the seam references member ids
// that live on the other DB, so we drop that one FK on the batch's DB at seed time (the cross-seam
// reality where the item row survives while the member's authoritative row lives on the other DB).
import { PostgresRunStore } from "@internal/run-store";
import { heteroPostgresTest, postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ApiBatchResultsPresenter } from "~/presenters/v3/ApiBatchResultsPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

// 26-char v1 body (version "1" at index 25) → NEW residency. 25-char body → LEGACY residency (cuid analog).
function newRunId(c: string) {
  return c.repeat(24) + "01";
}
function legacyRunId(c: string) {
  return c.repeat(25);
}

// A prisma handle that throws on any access — proves the split path never reads it.
const throwingPrisma = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(
        `passthrough handle must not be touched on the split path (got .${String(prop)})`
      );
    },
  }
) as unknown as PrismaReplicaClient;

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

// Mirror the same org/project/env ids onto a second DB so member TaskRun FKs resolve there.
async function mirrorEnv(prisma: PrismaClient, ctx: SeedCtx, slug: string) {
  const n = seedCounter++;
  await prisma.organization.create({
    data: { id: ctx.organization.id, title: `Org ${slug}`, slug: `org-${slug}-m-${n}` },
  });
  await prisma.project.create({
    data: {
      id: ctx.project.id,
      name: `Proj ${slug}`,
      slug: `proj-${slug}-m-${n}`,
      organizationId: ctx.organization.id,
      externalRef: `ext-${slug}-m-${n}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environment.id,
      slug: `env-${slug}-m-${n}`,
      type: "PRODUCTION",
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
      apiKey: `api-${slug}-m-${n}`,
      pkApiKey: `pk-${slug}-m-${n}`,
      shortcode: `sc-${slug}-m-${n}`,
    },
  });
}

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

// Drop the per-DB BatchTaskRunItem -> TaskRun FK so items on this DB can reference member ids whose
// authoritative TaskRun lives on the other DB (the cross-seam batch). Also drop the TaskRunAttempt
// worker/queue FKs so we can seed attempts (their output/error is what's under test) without
// standing up BackgroundWorker/TaskQueue parents — those rows are incidental to this read path.
async function relaxFks(prisma: PrismaClient) {
  for (const sql of [
    `ALTER TABLE "BatchTaskRunItem" DROP CONSTRAINT IF EXISTS "BatchTaskRunItem_taskRunId_fkey"`,
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

describe("ApiBatchResultsPresenter read-through (legacy + new DB)", () => {
  // A batch with members on BOTH DBs returns the complete set, byte-identical.
  heteroPostgresTest(
    "members spanning NEW + legacy hydrate to the complete union, in item order",
    async ({ prisma14, prisma17 }) => {
      const newDb = prisma17 as unknown as PrismaClient;
      const legacyDb = prisma14 as unknown as PrismaClient;

      const ctx = await seedEnv(newDb, "span-new");
      await mirrorEnv(legacyDb, ctx, "span-legacy");
      await relaxFks(newDb);
      await relaxFks(legacyDb);

      const newMemberId = newRunId("a");
      const legacyMemberId = legacyRunId("b");

      // NEW member lives only on the new DB, legacy member only on the legacy DB.
      await seedMember(newDb, ctx, {
        id: newMemberId,
        friendlyId: "run_new_a",
        status: "COMPLETED_SUCCESSFULLY",
        output: JSON.stringify({ from: "new" }),
      });
      await seedMember(legacyDb, ctx, {
        id: legacyMemberId,
        friendlyId: "run_legacy_b",
        status: "COMPLETED_WITH_ERRORS",
        error: { type: "BUILT_IN_ERROR", name: "Err", message: "boom", stackTrace: "" },
      });

      // The batch row + items live on the NEW DB; items reference both members.
      await seedBatch(newDb, ctx, "batch_span", [newMemberId, legacyMemberId]);

      const presenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const result = await presenter.call("batch_span", env(ctx));

      expect(result).toBeDefined();
      expect(result!.id).toBe("batch_span");
      expect(result!.items).toHaveLength(2);

      // Order follows item order: NEW member first, legacy member second.
      const [first, second] = result!.items;
      expect(first).toEqual({
        ok: true,
        id: "run_new_a",
        taskIdentifier: "my-task",
        output: JSON.stringify({ from: "new" }),
        outputType: "application/json",
      });
      expect(second).toMatchObject({
        ok: false,
        id: "run_legacy_b",
        taskIdentifier: "my-task",
      });
    }
  );

  // Batch row resident only on the legacy replica resolves via new-first-miss → legacy.
  heteroPostgresTest(
    "a legacy-resident batch row resolves off the legacy replica (new probe misses)",
    async ({ prisma14, prisma17 }) => {
      const newDb = prisma17 as unknown as PrismaClient;
      const legacyDb = prisma14 as unknown as PrismaClient;

      const ctx = await seedEnv(legacyDb, "lb-legacy");
      await mirrorEnv(newDb, ctx, "lb-new");
      await relaxFks(legacyDb);

      const legacyMemberId = legacyRunId("c");
      await seedMember(legacyDb, ctx, {
        id: legacyMemberId,
        friendlyId: "run_legacy_c",
        status: "COMPLETED_SUCCESSFULLY",
        output: JSON.stringify({ ok: 1 }),
      });
      // Batch row + items only on the legacy replica; absent from NEW.
      await seedBatch(legacyDb, ctx, "batch_legacy", [legacyMemberId]);

      const presenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const result = await presenter.call("batch_legacy", env(ctx));

      expect(result).toBeDefined();
      expect(result!.id).toBe("batch_legacy");
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]).toMatchObject({ ok: true, id: "run_legacy_c" });
    }
  );

  // Past-retention / missing member is omitted (dangling-ref gate adjacent), not errored.
  heteroPostgresTest(
    "a member present on neither DB is omitted; the reachable members still return",
    async ({ prisma14, prisma17 }) => {
      const newDb = prisma17 as unknown as PrismaClient;
      const legacyDb = prisma14 as unknown as PrismaClient;

      const ctx = await seedEnv(newDb, "dangle-new");
      await mirrorEnv(legacyDb, ctx, "dangle-legacy");
      await relaxFks(newDb);
      await relaxFks(legacyDb);

      const presentId = newRunId("e");
      const missingId = legacyRunId("f"); // referenced by an item but seeded on NO DB

      await seedMember(newDb, ctx, {
        id: presentId,
        friendlyId: "run_present_e",
        status: "COMPLETED_SUCCESSFULLY",
        output: JSON.stringify({ present: true }),
      });
      await seedBatch(newDb, ctx, "batch_dangle", [presentId, missingId]);

      const presenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const result = await presenter.call("batch_dangle", env(ctx));

      expect(result).toBeDefined();
      // The dangling member is dropped; the reachable member still returns. The dangling-reference
      // termination gate (separate unit) governs whether such omission is permitted pre-termination.
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]).toMatchObject({ ok: true, id: "run_present_e" });
    }
  );

  heteroPostgresTest(
    "an absent batch friendlyId returns undefined (split on)",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedEnv(prisma17 as unknown as PrismaClient, "nf-new");
      await mirrorEnv(prisma14 as unknown as PrismaClient, ctx, "nf-legacy");

      const presenter = new ApiBatchResultsPresenter(throwingPrisma, throwingPrisma, {
        splitEnabled: true,
        newClient: prisma17 as unknown as PrismaReplicaClient,
        legacyReplica: prisma14 as unknown as PrismaReplicaClient,
      });

      const result = await presenter.call("batch_does_not_exist", env(ctx));
      expect(result).toBeUndefined();
    }
  );
});

describe("ApiBatchResultsPresenter passthrough (single-DB collapse)", () => {
  // Single-DB: one batch read + one store id-set hydrate; legacy boundaries never touched.
  postgresTest(
    "single-DB hydrates the full set and never reaches the read-through boundaries",
    async ({ prisma }) => {
      const ctx = await seedEnv(prisma, "pt");
      await relaxFks(prisma);

      const memberId = legacyRunId("g");
      await seedMember(prisma, ctx, {
        id: memberId,
        friendlyId: "run_pt_g",
        status: "COMPLETED_SUCCESSFULLY",
        output: JSON.stringify({ value: 42 }),
      });
      await seedBatch(prisma, ctx, "batch_pt", [memberId]);

      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      // Throwing legacy replica: if the split path is entered, it blows up.
      const presenter = new ApiBatchResultsPresenter(
        prisma,
        prisma,
        {
          splitEnabled: false,
          legacyReplica: throwingPrisma,
        },
        runStore
      );

      const result = await presenter.call("batch_pt", env(ctx));

      expect(result).toBeDefined();
      expect(result!.id).toBe("batch_pt");
      expect(result!.items).toHaveLength(1);
      expect(result!.items[0]).toEqual({
        ok: true,
        id: "run_pt_g",
        taskIdentifier: "my-task",
        output: JSON.stringify({ value: 42 }),
        outputType: "application/json",
      });
    }
  );

  postgresTest("single-DB absent batch friendlyId returns undefined", async ({ prisma }) => {
    const ctx = await seedEnv(prisma, "pt-nf");
    const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

    const presenter = new ApiBatchResultsPresenter(
      prisma,
      prisma,
      { splitEnabled: false },
      runStore
    );

    const result = await presenter.call("batch_missing", env(ctx));
    expect(result).toBeUndefined();
  });
});
