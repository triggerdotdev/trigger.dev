import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import {
  ControlPlaneReferenceError,
  ControlPlaneResolver,
} from "~/v3/runOpsMigration/controlPlaneResolver.server";

// Cross-DB testcontainer spin-up + queries can exceed the 5s default on the first test.
vi.setConfig({ testTimeout: 60_000 });

// --- test helpers ----------------------------------------------------------

let seedCounter = 0;

/**
 * Wraps a real testcontainer PrismaClient with a `$extends` query hook that increments a
 * counter on every actual operation. NOT a mock: the returned client still issues the real
 * query and returns real rows — we only observe the DB boundary.
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
  return { org, project, environment };
}

async function seedWorker(
  prisma: PrismaClient,
  ctx: { projectId: string; environmentId: string },
  opts?: { promote?: boolean }
) {
  const n = seedCounter++;
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${n}`,
      contentHash: `hash_${n}`,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
      version: `2024.1.${n}`,
      metadata: {},
      engine: "V2",
    },
  });
  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${n}`,
      slug: `my-task-${n}`,
      filePath: "index.ts",
      exportName: "myTask",
      workerId: worker.id,
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${n}`,
      name: `task/my-task-${n}`,
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      workers: { connect: { id: worker.id } },
    },
  });
  let deployment = null;
  if (opts?.promote) {
    deployment = await prisma.workerDeployment.create({
      data: {
        friendlyId: `deployment_${n}`,
        contentHash: `hash_${n}`,
        version: worker.version,
        shortCode: `dep_${n}`,
        type: "MANAGED",
        status: "DEPLOYED",
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        workerId: worker.id,
      },
    });
    await prisma.workerDeploymentPromotion.create({
      data: {
        label: "current",
        deploymentId: deployment.id,
        environmentId: ctx.environmentId,
      },
    });
  }
  return { worker, task, queue, deployment };
}

// --- cache unit tests (no DB) ----------------------------------------------

describe("ControlPlaneCache", () => {
  it("caches null as a confirmed absence (distinct from a miss)", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    expect(cache.getEnv("env_x")).toBeUndefined();
    cache.setEnv("env_x", null);
    expect(cache.getEnv("env_x")).toBeNull();
  });

  it("invalidateEnv drops the entry (next read is a miss)", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    cache.setEnv("env_y", { id: "env_y" } as any);
    cache.invalidateEnv("env_y");
    expect(cache.getEnv("env_y")).toBeUndefined();
  });

  it("invalidating one key does not affect another", () => {
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    cache.setEnv("env_a", { id: "env_a" } as any);
    cache.setEnv("env_b", { id: "env_b" } as any);
    cache.invalidateEnv("env_a");
    expect(cache.getEnv("env_a")).toBeUndefined();
    expect(cache.getEnv("env_b")).toMatchObject({ id: "env_b" });
  });
});

// --- resolveEnv -------------------------------------------------------------

heteroPostgresTest(
  "resolveEnv returns the cross-DB env row and caches it",
  async ({ prisma14 }) => {
    const { environment, org } = await seedControlPlane(prisma14);
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache,
      splitEnabled: () => true,
    });

    const first = await resolver.resolveEnv(environment.id);
    expect(first).toMatchObject({
      id: environment.id,
      projectId: environment.projectId,
      organizationId: org.id,
      type: "PRODUCTION",
      archivedAt: null,
    });
    expect(reads()).toBe(1);

    const second = await resolver.resolveEnv(environment.id);
    expect(second).toEqual(first);
    expect(reads()).toBe(1);
  }
);

heteroPostgresTest("resolveEnv caches a null absence", async ({ prisma14 }) => {
  const cache = new ControlPlaneCache();
  const { client: counting, reads } = countQueries(prisma14);
  const resolver = new ControlPlaneResolver({
    controlPlaneReplica: counting,
    controlPlanePrimary: counting,
    cache,
    splitEnabled: () => true,
  });

  expect(await resolver.resolveEnv("env_does_not_exist")).toBeNull();
  expect(reads()).toBe(1);
  expect(await resolver.resolveEnv("env_does_not_exist")).toBeNull();
  expect(reads()).toBe(1);
});

heteroPostgresTest(
  "resolveEnv passthrough (split OFF) hits the DB every time, no cache",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => false,
    });

    await resolver.resolveEnv(environment.id);
    await resolver.resolveEnv(environment.id);
    expect(reads()).toBe(2);
  }
);

// --- resolveWorkerVersion ---------------------------------------------------

heteroPostgresTest(
  "resolveWorkerVersion (pinned) returns worker/tasks/queues and caches it",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { worker, task, queue } = await seedWorker(prisma14, {
      projectId: project.id,
      environmentId: environment.id,
    });
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    const first = await resolver.resolveWorkerVersion({
      environmentId: environment.id,
      backgroundWorkerId: worker.id,
    });
    expect(first?.worker.id).toBe(worker.id);
    expect(first?.tasks.map((t) => t.id)).toContain(task.id);
    expect(first?.queues.map((q) => q.id)).toContain(queue.id);
    expect(first?.deployment).toBeNull();
    const readsAfterFirst = reads();
    expect(readsAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await resolver.resolveWorkerVersion({
      environmentId: environment.id,
      backgroundWorkerId: worker.id,
    });
    expect(second?.worker.id).toBe(worker.id);
    expect(reads()).toBe(readsAfterFirst);
  }
);

heteroPostgresTest(
  "resolveWorkerVersion (current deployment) resolves the promoted worker",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { worker, deployment } = await seedWorker(
      prisma14,
      { projectId: project.id, environmentId: environment.id },
      { promote: true }
    );
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    const first = await resolver.resolveWorkerVersion({ environmentId: environment.id });
    expect(first?.worker.id).toBe(worker.id);
    expect(first?.deployment?.id).toBe(deployment?.id);
    const readsAfterFirst = reads();

    const second = await resolver.resolveWorkerVersion({ environmentId: environment.id });
    expect(second?.worker.id).toBe(worker.id);
    expect(reads()).toBe(readsAfterFirst);
  }
);

heteroPostgresTest(
  "resolveWorkerVersion passthrough (split OFF) re-reads every call",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { worker } = await seedWorker(prisma14, {
      projectId: project.id,
      environmentId: environment.id,
    });
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => false,
    });

    await resolver.resolveWorkerVersion({
      environmentId: environment.id,
      backgroundWorkerId: worker.id,
    });
    const readsAfterFirst = reads();
    await resolver.resolveWorkerVersion({
      environmentId: environment.id,
      backgroundWorkerId: worker.id,
    });
    expect(reads()).toBe(readsAfterFirst * 2);
  }
);

// --- assertEnvExists --------------------------------------------------------

heteroPostgresTest(
  "assertEnvExists resolves for a seeded env, caches, and throws for a missing one",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    await expect(resolver.assertEnvExists(environment.id)).resolves.toBeUndefined();
    expect(reads()).toBe(1);
    await expect(resolver.assertEnvExists(environment.id)).resolves.toBeUndefined();
    expect(reads()).toBe(1);

    await expect(resolver.assertEnvExists("env_missing")).rejects.toBeInstanceOf(
      ControlPlaneReferenceError
    );
  }
);

heteroPostgresTest(
  "assertEnvExists passthrough (split OFF) is a no-op: never reads, never throws",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => false,
    });

    // Split OFF = single DB, run and env co-located, so there is nothing to assert
    // and the hot-path read is skipped entirely — resolves for present and missing.
    await expect(resolver.assertEnvExists(environment.id)).resolves.toBeUndefined();
    await expect(resolver.assertEnvExists("env_missing")).resolves.toBeUndefined();
    expect(reads()).toBe(0);
  }
);

// --- resolveAuthenticatedEnv ------------------------------------------------

heteroPostgresTest(
  "resolveAuthenticatedEnv returns the toAuthenticated shape and caches it",
  async ({ prisma14 }) => {
    const { environment, project, org } = await seedControlPlane(prisma14);
    const { client: counting, reads } = countQueries(prisma14);
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache,
      splitEnabled: () => true,
    });

    const first = await resolver.resolveAuthenticatedEnv(environment.id);
    expect(first).not.toBeNull();
    expect(first!.id).toBe(environment.id);
    expect(first!.slug).toBe(environment.slug);
    expect(first!.type).toBe("PRODUCTION");
    expect(first!.organizationId).toBe(org.id);
    expect(first!.projectId).toBe(project.id);
    expect(first!.project.id).toBe(project.id);
    expect(first!.project.externalRef).toBe(project.externalRef);
    expect(first!.organization.id).toBe(org.id);
    expect(first!.organization.title).toBe(org.title);
    // concurrencyLimitBurstFactor is coerced to a plain number by toAuthenticated().
    expect(typeof first!.concurrencyLimitBurstFactor).toBe("number");
    expect(reads()).toBe(1);

    const second = await resolver.resolveAuthenticatedEnv(environment.id);
    expect(second).toEqual(first);
    expect(reads()).toBe(1);

    expect(await resolver.resolveAuthenticatedEnv("env_missing")).toBeNull();
  }
);

heteroPostgresTest(
  "resolveAuthenticatedEnv populates parentEnvironment { id, apiKey } for a branch env",
  async ({ prisma14 }) => {
    const m = seedCounter++;
    const org = await prisma14.organization.create({
      data: { title: `Org wp ${m}`, slug: `org-wp-${m}` },
    });
    const project = await prisma14.project.create({
      data: {
        name: `P wp ${m}`,
        slug: `p-wp-${m}`,
        externalRef: `proj_wp_${m}`,
        organizationId: org.id,
      },
    });
    const parent = await prisma14.runtimeEnvironment.create({
      data: {
        type: "PREVIEW",
        slug: `preview-parent-${m}`,
        projectId: project.id,
        organizationId: org.id,
        apiKey: `tr_parent_key_${m}`,
        pkApiKey: `pk_parent_${m}`,
        shortcode: `sc_parent_${m}`,
      },
    });
    const branch = await prisma14.runtimeEnvironment.create({
      data: {
        type: "PREVIEW",
        slug: `preview-branch-${m}`,
        branchName: "feat/x",
        projectId: project.id,
        organizationId: org.id,
        apiKey: `tr_branch_key_${m}`,
        pkApiKey: `pk_branch_${m}`,
        shortcode: `sc_branch_${m}`,
        parentEnvironmentId: parent.id,
      },
    });

    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: prisma14,
      controlPlanePrimary: prisma14,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    const env = await resolver.resolveAuthenticatedEnv(branch.id);
    expect(env).not.toBeNull();
    expect(env!.apiKey).toBe(`tr_branch_key_${m}`);
    expect(env!.parentEnvironment).not.toBeNull();
    expect(env!.parentEnvironment!.id).toBe(parent.id);
    expect(env!.parentEnvironment!.apiKey).toBe(`tr_parent_key_${m}`);

    const noParent = await resolver.resolveAuthenticatedEnv(parent.id);
    expect(noParent!.parentEnvironment).toBeNull();
  }
);

heteroPostgresTest(
  "resolveAuthenticatedEnv passthrough (split OFF) hits the DB every time, no cache",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => false,
    });

    await resolver.resolveAuthenticatedEnv(environment.id);
    await resolver.resolveAuthenticatedEnv(environment.id);
    expect(reads()).toBe(2);
  }
);

heteroPostgresTest(
  "resolveAuthenticatedEnv carries the `git` column (cached across calls)",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const gitMeta = { commitSha: "abc123", branchName: "main" };
    await prisma14.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { git: gitMeta },
    });

    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
      splitEnabled: () => true,
    });

    const first = await resolver.resolveAuthenticatedEnv(environment.id);
    expect(first).not.toBeNull();
    expect(first!.git).toEqual(gitMeta);
    expect(reads()).toBe(1);

    // Served from cache, still carrying `git`.
    const second = await resolver.resolveAuthenticatedEnv(environment.id);
    expect(second!.git).toEqual(gitMeta);
    expect(reads()).toBe(1);
  }
);

// --- invalidation over the DB boundary -------------------------------------

heteroPostgresTest(
  "invalidateEnvironment forces resolveEnv/resolveAuthenticatedEnv to re-read after a write",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: prisma14,
      controlPlanePrimary: prisma14,
      cache,
      splitEnabled: () => true,
    });

    // Warm both env-scoped slots.
    expect((await resolver.resolveEnv(environment.id))!.maximumConcurrencyLimit).not.toBe(999);
    expect((await resolver.resolveAuthenticatedEnv(environment.id))!.paused).toBe(false);

    // Control-plane write + invalidation (as a write site would do).
    await prisma14.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { maximumConcurrencyLimit: 999, paused: true },
    });
    resolver.invalidateEnvironment(environment.id);

    expect((await resolver.resolveEnv(environment.id))!.maximumConcurrencyLimit).toBe(999);
    expect((await resolver.resolveAuthenticatedEnv(environment.id))!.paused).toBe(true);
  }
);

heteroPostgresTest(
  "without invalidation a cached env stays stale after a control-plane write (fail-before contrast)",
  async ({ prisma14 }) => {
    const { environment } = await seedControlPlane(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: prisma14,
      controlPlanePrimary: prisma14,
      cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
      splitEnabled: () => true,
    });

    const before = (await resolver.resolveEnv(environment.id))!.maximumConcurrencyLimit;
    await prisma14.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { maximumConcurrencyLimit: 777 },
    });

    // No invalidation: the cache still serves the pre-write value (this is the bug the
    // write-site invalidation fixes).
    expect((await resolver.resolveEnv(environment.id))!.maximumConcurrencyLimit).toBe(before);

    // And with invalidation it re-reads.
    resolver.invalidateEnvironment(environment.id);
    expect((await resolver.resolveEnv(environment.id))!.maximumConcurrencyLimit).toBe(777);
  }
);

heteroPostgresTest(
  "invalidateOrganization forces every env of the org to re-read after an org write",
  async ({ prisma14 }) => {
    const { org: organization, project } = await seedControlPlane(prisma14);
    // A second env in the same org.
    const m = seedCounter++;
    const secondEnv = await prisma14.runtimeEnvironment.create({
      data: {
        type: "STAGING",
        slug: `env-second-${m}`,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_stg_${m}`,
        pkApiKey: `pk_stg_${m}`,
        shortcode: `short_stg_${m}`,
      },
    });
    const firstEnv = await prisma14.runtimeEnvironment.findFirstOrThrow({
      where: { projectId: project.id, type: "PRODUCTION" },
    });

    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: prisma14,
      controlPlanePrimary: prisma14,
      cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
      splitEnabled: () => true,
    });

    // Warm both envs' authEnv slots.
    expect((await resolver.resolveAuthenticatedEnv(firstEnv.id))!.organization.runsEnabled).toBe(
      true
    );
    expect((await resolver.resolveAuthenticatedEnv(secondEnv.id))!.organization.runsEnabled).toBe(
      true
    );

    // Org-level write (runsEnabled) + a single org invalidation.
    await prisma14.organization.update({
      where: { id: organization.id },
      data: { runsEnabled: false },
    });
    resolver.invalidateOrganization(organization.id);

    // BOTH envs re-read and now observe the org change, with no reverse org->env index.
    expect((await resolver.resolveAuthenticatedEnv(firstEnv.id))!.organization.runsEnabled).toBe(
      false
    );
    expect((await resolver.resolveAuthenticatedEnv(secondEnv.id))!.organization.runsEnabled).toBe(
      false
    );
  }
);

// --- resolveRunLockedWorker -------------------------------------------------

heteroPostgresTest(
  "resolveRunLockedWorker returns lockedBy (task+worker+deployment) and lockedToVersion, caches it",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { worker, task, deployment } = await seedWorker(
      prisma14,
      { projectId: project.id, environmentId: environment.id },
      { promote: true }
    );
    const { client: counting, reads } = countQueries(prisma14);
    const cache = new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 });
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache,
      splitEnabled: () => true,
    });

    const first = await resolver.resolveRunLockedWorker({
      lockedById: task.id,
      lockedToVersionId: worker.id,
    });
    expect(first).not.toBeNull();
    expect(first!.lockedBy!.id).toBe(task.id);
    expect(first!.lockedBy!.filePath).toBe(task.filePath);
    expect(first!.lockedBy!.slug).toBe(task.slug);
    expect(first!.lockedBy!.exportName).toBe(task.exportName);
    expect(first!.lockedBy!.machineConfig).toEqual(task.machineConfig);
    expect(first!.lockedBy!.worker.id).toBe(worker.id);
    expect(first!.lockedBy!.worker.version).toBe(worker.version);
    expect(first!.lockedBy!.worker.deployment!.friendlyId).toBe(deployment!.friendlyId);
    expect(first!.lockedToVersion!.version).toBe(worker.version);
    expect(first!.lockedToVersion!.supportsLazyAttempts).toBe(worker.supportsLazyAttempts);
    const readsAfterFirst = reads();
    expect(readsAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await resolver.resolveRunLockedWorker({
      lockedById: task.id,
      lockedToVersionId: worker.id,
    });
    expect(second).toEqual(first);
    expect(reads()).toBe(readsAfterFirst);
  }
);

heteroPostgresTest(
  "resolveRunLockedWorker returns null lockedBy/lockedToVersion when ids are absent",
  async ({ prisma14 }) => {
    const { client: counting } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });

    const resolved = await resolver.resolveRunLockedWorker({
      lockedById: null,
      lockedToVersionId: null,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.lockedBy).toBeNull();
    expect(resolved!.lockedToVersion).toBeNull();
  }
);

heteroPostgresTest(
  "resolveRunLockedWorker resolves lockedBy only when lockedToVersionId is absent",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { task } = await seedWorker(
      prisma14,
      { projectId: project.id, environmentId: environment.id },
      { promote: true }
    );
    const { client: counting } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
      splitEnabled: () => true,
    });

    const result = await resolver.resolveRunLockedWorker({ lockedById: task.id });
    expect(result).not.toBeNull();
    expect(result!.lockedBy!.id).toBe(task.id);
    expect(result!.lockedBy!.slug).toBe(task.slug);
    expect(result!.lockedToVersion).toBeNull();
  }
);

heteroPostgresTest(
  "resolveRunLockedWorker resolves lockedToVersion only when lockedById is absent",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { worker } = await seedWorker(
      prisma14,
      { projectId: project.id, environmentId: environment.id },
      { promote: true }
    );
    const { client: counting } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
      splitEnabled: () => true,
    });

    const result = await resolver.resolveRunLockedWorker({ lockedToVersionId: worker.id });
    expect(result).not.toBeNull();
    expect(result!.lockedToVersion!.version).toBe(worker.version);
    expect(result!.lockedBy).toBeNull();
  }
);

heteroPostgresTest(
  "resolveRunLockedWorker passthrough (split OFF) re-reads every call",
  async ({ prisma14 }) => {
    const { environment, project } = await seedControlPlane(prisma14);
    const { worker, task } = await seedWorker(prisma14, {
      projectId: project.id,
      environmentId: environment.id,
    });
    const { client: counting, reads } = countQueries(prisma14);
    const resolver = new ControlPlaneResolver({
      controlPlaneReplica: counting,
      controlPlanePrimary: counting,
      cache: new ControlPlaneCache(),
      splitEnabled: () => false,
    });

    await resolver.resolveRunLockedWorker({ lockedById: task.id, lockedToVersionId: worker.id });
    const readsAfterFirst = reads();
    await resolver.resolveRunLockedWorker({ lockedById: task.id, lockedToVersionId: worker.id });
    expect(reads()).toBe(readsAfterFirst * 2);
  }
);
