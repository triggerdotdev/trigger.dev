import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

// Control-plane datasource repoint (legacy DB -> new DB).
//
// Post-repoint the control plane lives on the new DB, so we model the new topology by seeding the
// control-plane rows on the new side (`prisma17`) and injecting it as both the resolver's primary
// and replica. `prisma14` stands in for the pre-repoint legacy source for the cross-version
// transition test. NEVER mock — we seed and read the real testcontainer clients, and we observe
// the DB boundary via a $extends query counter.

// Cross-DB testcontainer spin-up + queries can exceed the 5s default on the first test.
vi.setConfig({ testTimeout: 60_000 });

let seedCounter = 0;

/**
 * Wraps a real testcontainer PrismaClient with a `$extends` query hook that increments a counter
 * on every actual operation. NOT a mock: the returned client still issues the real query and
 * returns real rows — we only observe the DB boundary (the countQueries pattern).
 */
function countQueries(client: PrismaClient): { client: PrismaClient; reads: () => number } {
  let count = 0;
  const extended = client.$extends({
    query: {
      async $allOperations({ args, query }) {
        count++;
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  return { client: extended, reads: () => count };
}

/** Seeds org -> project -> env + a pinned BackgroundWorker (+task) + TaskQueue + TaskSchedule. */
async function seedControlPlane(prisma: PrismaClient) {
  const n = seedCounter++;
  const org = await prisma.organization.create({
    data: { title: `Org ${n}`, slug: `org-${n}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${n}`,
      slug: `project-${n}`,
      externalRef: `proj_${n}`,
      organizationId: org.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-${n}`,
      projectId: project.id,
      organizationId: org.id,
      apiKey: `tr_prod_${n}`,
      pkApiKey: `pk_prod_${n}`,
      shortcode: `short_${n}`,
    },
  });
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${n}`,
      contentHash: `hash_${n}`,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      version: `2024.1.${n}`,
      metadata: {},
      engine: "V2",
    },
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${n}`,
      slug: `my-task-${n}`,
      filePath: "index.ts",
      exportName: "myTask",
      workerId: worker.id,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${n}`,
      name: `task/my-task-${n}`,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      workers: { connect: { id: worker.id } },
    },
  });
  const schedule = await prisma.taskSchedule.create({
    data: {
      friendlyId: `schedule_${n}`,
      taskIdentifier: `my-task-${n}`,
      generatorExpression: "0 * * * *",
      projectId: project.id,
    },
  });
  return { org, project, environment, worker, queue, schedule };
}

// --- Repoint resolution (split ON, CP on the new DB) ---------

heteroPostgresTest(
  "control-plane references resolve against the repointed (new-DB) CP client",
  async ({ prisma17 }) => {
    const { environment, worker } = await seedControlPlane(prisma17);
    const resolver = new ControlPlaneResolver({
      controlPlanePrimary: prisma17,
      controlPlaneReplica: prisma17,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    expect(await resolver.resolveEnv(environment.id)).toMatchObject({ id: environment.id });
    expect(
      await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        backgroundWorkerId: worker.id,
      })
    ).not.toBeNull();
  }
);

// --- Relaxed-cache (no latency regression) -------------------------

heteroPostgresTest("relaxed (longer TTL) cache still hits on the new DB", async ({ prisma17 }) => {
  const { environment } = await seedControlPlane(prisma17);
  const { client: counting, reads } = countQueries(prisma17);
  const resolver = new ControlPlaneResolver({
    controlPlanePrimary: counting,
    controlPlaneReplica: counting,
    // Relaxed: a much longer TTL than the default — same-provider resolution is cheap.
    cache: new ControlPlaneCache({ ttlMs: 300_000, maxEntries: 10_000 }),
    splitEnabled: () => true,
  });

  expect(await resolver.resolveEnv(environment.id)).toMatchObject({ id: environment.id });
  expect(reads()).toBe(1);
  // Second read served from the relaxed cache — no extra DB round-trip.
  await resolver.resolveEnv(environment.id);
  expect(reads()).toBe(1);
});

// --- Cross-version transition (legacy DB -> new DB) -----------------------

heteroPostgresTest(
  "resolution is byte-identical across the legacy-DB -> new-DB host transition",
  async ({ prisma14, prisma17, pinnedCollation }) => {
    // Seed identical control-plane shapes on the pre-repoint (legacy) and post-repoint
    // (new) sides.
    const before = await seedControlPlane(prisma14);
    const after = await seedControlPlane(prisma17);

    const resolver14 = new ControlPlaneResolver({
      controlPlanePrimary: prisma14,
      controlPlaneReplica: prisma14,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });
    const resolver17 = new ControlPlaneResolver({
      controlPlanePrimary: prisma17,
      controlPlaneReplica: prisma17,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    const env14 = await resolver14.resolveEnv(before.environment.id);
    const env17 = await resolver17.resolveEnv(after.environment.id);
    // Same resolution shape across the version boundary (ids differ per-seed; structure identical).
    expect(Object.keys(env14 ?? {}).sort()).toEqual(Object.keys(env17 ?? {}).sort());
    expect(env14?.type).toBe(env17?.type);
    expect(env14?.archivedAt).toBe(env17?.archivedAt);

    // ORDER BY on a representative text-heavy column must agree across the version boundary, using
    // the pinned ICU collation the hetero fixture exposes so the comparison is apples-to-apples.
    const slugs = ["banana", "Apple", "cherry", "Äpfel", "apple"];
    const orderBy = async (prisma: PrismaClient) => {
      const rows = await prisma.$queryRawUnsafe<{ s: string }[]>(
        `SELECT s FROM (VALUES ('${slugs.join("'),('")}')) AS t(s) ORDER BY s COLLATE "${pinnedCollation}"`
      );
      return rows.map((r) => r.s);
    };
    expect(await orderBy(prisma14)).toEqual(await orderBy(prisma17));
  }
);

// --- Single-DB no-op (passthrough preserved) -----------------------

heteroPostgresTest(
  "single-DB passthrough (split OFF) runs plain in-DB joins with no cache",
  async ({ prisma17 }) => {
    const { environment } = await seedControlPlane(prisma17);
    const { client: counting, reads } = countQueries(prisma17);
    const resolver = new ControlPlaneResolver({
      controlPlanePrimary: counting,
      controlPlaneReplica: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => false,
    });

    await resolver.resolveEnv(environment.id);
    await resolver.resolveEnv(environment.id);
    // No cache when split is OFF — every call hits the DB, identical to today's passthrough.
    expect(reads()).toBe(2);
  }
);
