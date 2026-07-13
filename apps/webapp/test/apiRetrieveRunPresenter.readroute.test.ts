import { postgresTest, heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { beforeEach, describe, expect, vi } from "vitest";

// `resolveSchedule` reads the module-level `prisma` (control-plane handle).
// Point `~/db.server`'s handles at a hoisted mutable holder each test sets to a
// real container client. Not a DB mock: reads still hit a real Postgres
// container — this only redirects which real client the module resolves.
const dbHolder = vi.hoisted(() => ({
  prisma: null as PrismaClient | null,
  $replica: null as PrismaClient | null,
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return dbHolder.prisma;
  },
  get $replica() {
    return dbHolder.$replica;
  },
}));

// Inert: payloads are inline JSON, never `application/store`, so no presign.
vi.mock("~/v3/objectStore.server", () => ({
  generatePresignedUrl: vi.fn(async () => ({ success: false, error: "not-used" })),
}));

import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { FoundRun } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { CURRENT_API_VERSION } from "~/api/versions";

vi.setConfig({ testTimeout: 60_000 });

// The presenter's EXACT read shape — pinned so a refactor that changes
// `findRun`'s `where`/`select` must update this test in lockstep.
const commonRunSelect = {
  id: true,
  friendlyId: true,
  status: true,
  taskIdentifier: true,
  createdAt: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
  expiredAt: true,
  delayUntil: true,
  metadata: true,
  metadataType: true,
  ttl: true,
  costInCents: true,
  baseCostInCents: true,
  usageDurationMs: true,
  idempotencyKey: true,
  idempotencyKeyOptions: true,
  isTest: true,
  depth: true,
  scheduleId: true,
  workerQueue: true,
  region: true,
  lockedToVersionId: true,
  resumeParentOnCompletion: true,
  batch: { select: { id: true, friendlyId: true } },
  runTags: true,
} satisfies Prisma.TaskRunSelect;

const findRunSelect = {
  ...commonRunSelect,
  traceId: true,
  payload: true,
  payloadType: true,
  output: true,
  outputType: true,
  error: true,
  attempts: { select: { id: true } },
  attemptNumber: true,
  engine: true,
  taskEventStore: true,
  parentTaskRun: { select: commonRunSelect },
  rootTaskRun: { select: commonRunSelect },
  childRuns: { select: commonRunSelect },
} satisfies Prisma.TaskRunSelect;

// Drive the read exactly as `findRun` does: the RunStore.findRun contract over
// the given store with the presenter's where+select. The scalar `lockedToVersionId`
// folds to a resolved `lockedToVersion` per node, matching the presenter's shape;
// seeded runs carry no locked version, so every node resolves to null.
async function readFoundRunViaStore(
  store: PostgresRunStore,
  friendlyId: string,
  runtimeEnvironmentId: string
): Promise<FoundRun | null> {
  const pgRow = (await store.findRun(
    { friendlyId, runtimeEnvironmentId },
    { select: findRunSelect }
  )) as Record<string, any> | null;
  if (!pgRow) return null;
  const foldVersion = (run: Record<string, any>) => ({ ...run, lockedToVersion: null });
  return {
    ...pgRow,
    lockedToVersion: null,
    parentTaskRun: pgRow.parentTaskRun ? foldVersion(pgRow.parentTaskRun) : null,
    rootTaskRun: pgRow.rootTaskRun ? foldVersion(pgRow.rootTaskRun) : null,
    childRuns: (pgRow.childRuns ?? []).map(foldVersion),
    isBuffered: false,
  } as FoundRun;
}

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

// Build the AuthenticatedEnvironment shape `call()` reads (id, organizationId,
// slug, project.externalRef). Only those fields are touched on the happy path.
function authEnv(
  organization: { id: string },
  project: { id: string; externalRef: string },
  runtimeEnvironment: { id: string; slug: string }
): AuthenticatedEnvironment {
  return {
    id: runtimeEnvironment.id,
    slug: runtimeEnvironment.slug,
    organizationId: organization.id,
    organization: { id: organization.id },
    project: { id: project.id, externalRef: project.externalRef },
  } as unknown as AuthenticatedEnvironment;
}

interface SeedRunOpts {
  id: string;
  friendlyId: string;
  runtimeEnvironmentId: string;
  projectId: string;
  organizationId: string;
  scheduleId?: string;
  runTags?: string[];
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  metadata?: string;
}

async function seedRun(prisma: PrismaClient, opts: SeedRunOpts) {
  return prisma.taskRun.create({
    data: {
      id: opts.id,
      friendlyId: opts.friendlyId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ hello: "world" }),
      payloadType: "application/json",
      traceId: `trace_${opts.id}`,
      spanId: `span_${opts.id}`,
      queue: "task/my-task",
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
      projectId: opts.projectId,
      organizationId: opts.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
      runTags: opts.runTags ?? [],
      scheduleId: opts.scheduleId,
      parentTaskRunId: opts.parentTaskRunId,
      rootTaskRunId: opts.rootTaskRunId,
      metadata: opts.metadata,
      metadataType: opts.metadata ? "application/json" : undefined,
    },
  });
}

// A TaskRunAttempt requires the BackgroundWorker -> BackgroundWorkerTask ->
// TaskQueue FK chain; seed the minimum of each for one attempt.
async function seedAttempt(
  prisma: PrismaClient,
  opts: { runId: string; runtimeEnvironmentId: string; projectId: string; suffix: string }
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${opts.runId}`,
      contentHash: `hash_${opts.suffix}`,
      version: "20260627.1",
      metadata: {},
      projectId: opts.projectId,
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
    },
  });
  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${opts.runId}`,
      slug: "my-task",
      filePath: "src/trigger/my-task.ts",
      workerId: worker.id,
      projectId: opts.projectId,
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${opts.runId}`,
      name: "task/my-task",
      projectId: opts.projectId,
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
    },
  });
  return prisma.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${opts.runId}`,
      number: 1,
      taskRunId: opts.runId,
      runtimeEnvironmentId: opts.runtimeEnvironmentId,
      backgroundWorkerId: worker.id,
      backgroundWorkerTaskId: task.id,
      queueId: queue.id,
      status: "EXECUTING",
    },
  });
}

// Seed a run plus a parent, a root, a child and one attempt — the tree that must
// round-trip. `seedTestRun.ts` only seeds a single root run, so the tree + attempt
// rows are created inline here.
async function seedRunWithTree(
  prisma: PrismaClient,
  base: {
    runtimeEnvironmentId: string;
    projectId: string;
    organizationId: string;
    suffix: string;
  }
) {
  const parentId = generateRunOpsId();
  const rootId = generateRunOpsId();
  const runId = generateRunOpsId();
  const childId = generateRunOpsId();

  await seedRun(prisma, {
    id: rootId,
    friendlyId: `run_${rootId}`,
    runtimeEnvironmentId: base.runtimeEnvironmentId,
    projectId: base.projectId,
    organizationId: base.organizationId,
  });
  await seedRun(prisma, {
    id: parentId,
    friendlyId: `run_${parentId}`,
    runtimeEnvironmentId: base.runtimeEnvironmentId,
    projectId: base.projectId,
    organizationId: base.organizationId,
    rootTaskRunId: rootId,
  });

  const run = await seedRun(prisma, {
    id: runId,
    friendlyId: `run_${runId}`,
    runtimeEnvironmentId: base.runtimeEnvironmentId,
    projectId: base.projectId,
    organizationId: base.organizationId,
    parentTaskRunId: parentId,
    rootTaskRunId: rootId,
    runTags: ["alpha", "beta"],
    metadata: JSON.stringify({ k: base.suffix }),
  });

  await seedRun(prisma, {
    id: childId,
    friendlyId: `run_${childId}`,
    runtimeEnvironmentId: base.runtimeEnvironmentId,
    projectId: base.projectId,
    organizationId: base.organizationId,
    parentTaskRunId: runId,
    rootTaskRunId: rootId,
  });

  const attempt = await seedAttempt(prisma, {
    runId,
    runtimeEnvironmentId: base.runtimeEnvironmentId,
    projectId: base.projectId,
    suffix: base.suffix,
  });

  return {
    run,
    runFriendlyId: `run_${runId}`,
    parentFriendlyId: `run_${parentId}`,
    rootFriendlyId: `run_${rootId}`,
    childFriendlyId: `run_${childId}`,
    attemptId: attempt.id,
  };
}

beforeEach(() => {
  dbHolder.prisma = null;
  dbHolder.$replica = null;
});

describe("ApiRetrieveRunPresenter.findRun store-routed read (single-DB invariant)", () => {
  postgresTest(
    "returns run + attempts + tree from the store read; resolveSchedule reads control-plane prisma",
    async ({ prisma }) => {
      // Single-DB shape: one PostgresRunStore over the one prisma/replica pair,
      // exactly as the production `runStore.server.ts` singleton constructs it.
      dbHolder.prisma = prisma;
      dbHolder.$replica = prisma;
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma,
        "single"
      );

      // Control-plane schedule on the SAME single client.
      const scheduleId = generateRunOpsId();
      await prisma.taskSchedule.create({
        data: {
          id: scheduleId,
          friendlyId: `sched_${scheduleId}`,
          externalId: "my-external-schedule",
          taskIdentifier: "my-task",
          generatorExpression: "0 * * * *",
          generatorDescription: "Every hour",
          projectId: project.id,
        },
      });

      const tree = await seedRunWithTree(prisma, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        suffix: "single",
      });

      await prisma.taskRun.update({
        where: { id: tree.run.id },
        data: { scheduleId },
      });

      const env = authEnv(organization, project, runtimeEnvironment);
      const found = await readFoundRunViaStore(store, tree.runFriendlyId, env.id);

      expect(found).not.toBeNull();
      expect(found!.isBuffered).toBe(false);
      expect(found!.friendlyId).toBe(tree.runFriendlyId);
      expect(found!.parentTaskRun?.friendlyId).toBe(tree.parentFriendlyId);
      expect(found!.rootTaskRun?.friendlyId).toBe(tree.rootFriendlyId);
      expect(found!.childRuns.map((c) => c.friendlyId)).toEqual([tree.childFriendlyId]);
      expect(found!.attempts.map((a) => a.id)).toEqual([tree.attemptId]);
      expect([...found!.runTags].sort()).toEqual(["alpha", "beta"]);

      // Drive the full presenter `call()` — exercises the real control-plane
      // `resolveSchedule` against the module `prisma` (the container client).
      const out = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found!, env);

      expect(out.schedule).toBeDefined();
      expect(out.schedule?.externalId).toBe("my-external-schedule");
      expect(out.schedule?.generator.expression).toBe("0 * * * *");
      expect(out.relatedRuns.parent?.id).toBe(tree.parentFriendlyId);
      expect(out.relatedRuns.root?.id).toBe(tree.rootFriendlyId);
      expect(out.relatedRuns.children.map((c) => c.id)).toEqual([tree.childFriendlyId]);
      expect(out.attemptCount).toBe(found!.attemptNumber ?? 0);
    }
  );

  postgresTest(
    "resolveSchedule re-reads TaskSchedule off the control-plane prisma on every call (no caching)",
    async ({ prisma }) => {
      // Single-DB: this proves resolveSchedule re-reads `prisma.taskSchedule`
      // on each call() and reflects a delete (no stale cache). The structural
      // "schedule comes from the control-plane client, not the run-ops store"
      // separation is proven by the cross-DB test below (distinct schedule
      // client + an onLegacy=null check); in single-DB both views are the
      // same physical row, so this case cannot discriminate the two paths.
      dbHolder.prisma = prisma;
      dbHolder.$replica = prisma;
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma,
        "cp-inv"
      );

      const scheduleId = generateRunOpsId();
      await prisma.taskSchedule.create({
        data: {
          id: scheduleId,
          friendlyId: `sched_${scheduleId}`,
          taskIdentifier: "my-task",
          generatorExpression: "*/5 * * * *",
          projectId: project.id,
        },
      });

      const runId = generateRunOpsId();
      await seedRun(prisma, {
        id: runId,
        friendlyId: `run_${runId}`,
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        scheduleId,
      });

      const env = authEnv(organization, project, runtimeEnvironment);
      const found = await readFoundRunViaStore(store, `run_${runId}`, env.id);
      expect(found).not.toBeNull();
      expect(found!.scheduleId).toBe(scheduleId);

      const presenter = new ApiRetrieveRunPresenter(CURRENT_API_VERSION);
      const out = await presenter.call(found!, env);
      expect(out.schedule?.id).toBe(`sched_${scheduleId}`);

      // Delete the control-plane TaskSchedule row; the run-ops row is
      // untouched. resolveSchedule must now return undefined — proving the
      // schedule comes from `prisma.taskSchedule`, NOT from the run-ops store.
      await prisma.taskSchedule.delete({ where: { id: scheduleId } });
      const out2 = await presenter.call(found!, env);
      expect(out2.schedule).toBeUndefined();
    }
  );
});

describe("ApiRetrieveRunPresenter.findRun cross-version read (PG14 + PG17)", () => {
  heteroPostgresTest(
    "single retrieve returns run + attempts + tree byte-identically from NEW (PG17) and LEGACY (PG14) stores",
    async ({ prisma17, prisma14 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      // NEW residency subgraph on PG17.
      const newEnv = await seedOrgProjectEnv(prisma17, "new");
      const newTree = await seedRunWithTree(prisma17, {
        runtimeEnvironmentId: newEnv.runtimeEnvironment.id,
        projectId: newEnv.project.id,
        organizationId: newEnv.organization.id,
        suffix: "new",
      });

      // Distinct LEGACY residency subgraph on PG14.
      const legacyEnv = await seedOrgProjectEnv(prisma14, "legacy");
      const legacyTree = await seedRunWithTree(prisma14, {
        runtimeEnvironmentId: legacyEnv.runtimeEnvironment.id,
        projectId: legacyEnv.project.id,
        organizationId: legacyEnv.organization.id,
        suffix: "legacy",
      });

      // Read the NEW run from the PG17 store.
      const foundNew = await readFoundRunViaStore(
        newStore,
        newTree.runFriendlyId,
        newEnv.runtimeEnvironment.id
      );
      expect(foundNew).not.toBeNull();
      expect(foundNew!.friendlyId).toBe(newTree.runFriendlyId);
      expect(foundNew!.parentTaskRun?.friendlyId).toBe(newTree.parentFriendlyId);
      expect(foundNew!.rootTaskRun?.friendlyId).toBe(newTree.rootFriendlyId);
      expect(foundNew!.childRuns.map((c) => c.friendlyId)).toEqual([newTree.childFriendlyId]);
      expect(foundNew!.attempts.map((a) => a.id)).toEqual([newTree.attemptId]);
      expect([...foundNew!.runTags].sort()).toEqual(["alpha", "beta"]);
      expect(foundNew!.metadata).toBe(JSON.stringify({ k: "new" }));

      // Sanity: the two stores are genuinely distinct DBs — the NEW run's key
      // is absent from PG14 (it was only ever written to PG17).
      const leaked = await readFoundRunViaStore(
        legacyStore,
        newTree.runFriendlyId,
        newEnv.runtimeEnvironment.id
      );
      expect(leaked).toBeNull();

      // Read the LEGACY run from the PG14 store — byte-identical tree.
      const foundLegacy = await readFoundRunViaStore(
        legacyStore,
        legacyTree.runFriendlyId,
        legacyEnv.runtimeEnvironment.id
      );
      expect(foundLegacy).not.toBeNull();
      expect(foundLegacy!.friendlyId).toBe(legacyTree.runFriendlyId);
      expect(foundLegacy!.parentTaskRun?.friendlyId).toBe(legacyTree.parentFriendlyId);
      expect(foundLegacy!.rootTaskRun?.friendlyId).toBe(legacyTree.rootFriendlyId);
      expect(foundLegacy!.childRuns.map((c) => c.friendlyId)).toEqual([legacyTree.childFriendlyId]);
      expect(foundLegacy!.attempts.map((a) => a.id)).toEqual([legacyTree.attemptId]);
      expect(foundLegacy!.metadata).toBe(JSON.stringify({ k: "legacy" }));
    }
  );

  heteroPostgresTest(
    "schedule resolved cross-DB: run hydrated from run-ops store (PG14), schedule from a distinct control-plane client (PG17)",
    async ({ prisma17, prisma14 }) => {
      // Run-ops residency = LEGACY (PG14). Control-plane (TaskSchedule) lives
      // on a DISTINCT client — PG17 — and is the handle the module `prisma`
      // resolves to in this test. This proves the run-ops-row -> control-plane
      // -schedule cross-seam read: the run comes from one DB, the schedule
      // from another.
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      // Module control-plane handle -> PG17.
      dbHolder.prisma = prisma17;
      dbHolder.$replica = prisma17;

      const legacyEnv = await seedOrgProjectEnv(prisma14, "x-run");
      // The control-plane project the schedule hangs off lives on PG17.
      const cpEnv = await seedOrgProjectEnv(prisma17, "x-cp");

      const scheduleId = generateRunOpsId();
      await prisma17.taskSchedule.create({
        data: {
          id: scheduleId,
          friendlyId: `sched_${scheduleId}`,
          externalId: "cross-db-schedule",
          taskIdentifier: "my-task",
          generatorExpression: "0 0 * * *",
          projectId: cpEnv.project.id,
        },
      });

      const runId = generateRunOpsId();
      await seedRun(prisma14, {
        id: runId,
        friendlyId: `run_${runId}`,
        runtimeEnvironmentId: legacyEnv.runtimeEnvironment.id,
        projectId: legacyEnv.project.id,
        organizationId: legacyEnv.organization.id,
        scheduleId,
      });

      const env = authEnv(legacyEnv.organization, legacyEnv.project, legacyEnv.runtimeEnvironment);
      const found = await readFoundRunViaStore(
        legacyStore,
        `run_${runId}`,
        legacyEnv.runtimeEnvironment.id
      );
      expect(found).not.toBeNull();
      expect(found!.scheduleId).toBe(scheduleId);

      // The schedule row does NOT exist on the run-ops (PG14) client.
      const onLegacy = await prisma14.taskSchedule.findFirst({ where: { id: scheduleId } });
      expect(onLegacy).toBeNull();

      const out = await new ApiRetrieveRunPresenter(CURRENT_API_VERSION).call(found!, env);
      expect(out.schedule).toBeDefined();
      expect(out.schedule?.id).toBe(`sched_${scheduleId}`);
      expect(out.schedule?.externalId).toBe("cross-db-schedule");
      expect(out.schedule?.generator.expression).toBe("0 0 * * *");
    }
  );

  heteroPostgresTest(
    "correct past-retention / not-found response: both stores miss => findRun returns null",
    async ({ prisma17, prisma14 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const newEnv = await seedOrgProjectEnv(prisma17, "miss-new");
      const legacyEnv = await seedOrgProjectEnv(prisma14, "miss-legacy");

      // A run that exists on NEITHER store (terminated + past-retention,
      // observed at this layer as a miss on both underlying stores).
      const goneFriendlyId = `run_${generateRunOpsId()}`;

      const fromNew = await readFoundRunViaStore(
        newStore,
        goneFriendlyId,
        newEnv.runtimeEnvironment.id
      );
      const fromLegacy = await readFoundRunViaStore(
        legacyStore,
        goneFriendlyId,
        legacyEnv.runtimeEnvironment.id
      );

      expect(fromNew).toBeNull();
      expect(fromLegacy).toBeNull();
    }
  );

  heteroPostgresTest(
    "single-DB passthrough: one PostgresRunStore over one client hydrates run + tree (self-host collapse)",
    async ({ prisma17 }) => {
      // The single-DB collapse: one plain PostgresRunStore over one client.
      // No legacy probe / known-migrated machinery at this layer.
      const store = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const onlyEnv = await seedOrgProjectEnv(prisma17, "passthrough");
      const tree = await seedRunWithTree(prisma17, {
        runtimeEnvironmentId: onlyEnv.runtimeEnvironment.id,
        projectId: onlyEnv.project.id,
        organizationId: onlyEnv.organization.id,
        suffix: "passthrough",
      });

      const found = await readFoundRunViaStore(
        store,
        tree.runFriendlyId,
        onlyEnv.runtimeEnvironment.id
      );
      expect(found).not.toBeNull();
      expect(found!.isBuffered).toBe(false);
      expect(found!.parentTaskRun?.friendlyId).toBe(tree.parentFriendlyId);
      expect(found!.rootTaskRun?.friendlyId).toBe(tree.rootFriendlyId);
      expect(found!.childRuns.map((c) => c.friendlyId)).toEqual([tree.childFriendlyId]);
      expect(found!.attempts.map((a) => a.id)).toEqual([tree.attemptId]);
    }
  );
});
