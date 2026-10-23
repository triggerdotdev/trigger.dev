import { describe, expect, onTestFinished, vi } from "vitest";

// Points the module-level clients at each test's container database, so code
// that reads them (task identifier sync on promotion) writes real rows.
const db = vi.hoisted(() => ({ client: undefined as any }));
vi.mock("~/db.server", () => {
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        if (!db.client) throw new Error("db.client not set for this test");
        return db.client[prop];
      },
    }
  );
  return {
    prisma: client,
    $replica: client,
    webhookPrisma: client,
    runOpsNewPrisma: client,
    runOpsLegacyPrisma: client,
  };
});
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { Redis } from "ioredis";
import {
  allowsAnyCompat,
  resolveComputeMigration,
} from "~/runEngine/concerns/computeMigration.server";
import { workerQueueForBirth } from "~/runEngine/concerns/workerQueueAssignment.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import type { RunEngine } from "~/v3/runEngine.server";
import { RedisTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";
import { TemplatePrebuildService } from "~/v3/services/templatePrebuild.server";
import {
  backingForQueue,
  regionForQueue,
  selfBackingWorkerGroups,
  workerRegionRegistry,
} from "~/v3/workerRegions.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const KEY = "a".repeat(64);
const NEWER_KEY = "b".repeat(64);
const SLUG = "keyed-task";
const IMAGE = "registry.example.com/proj_abc:20260101.1.prod@sha256:" + "c".repeat(64);

type Environment = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

// resolveQueueProperties never touches the engine; it is only a constructor argument.
const noEngine = undefined as unknown as RunEngine;

async function createDeployment(
  prisma: PrismaClient,
  environment: Environment,
  options: { templateKey?: string; version: string }
) {
  const id = randomUUID();
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${id}`,
      contentHash: id,
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      version: options.version,
      metadata: {},
    },
  });
  const queue = await prisma.taskQueue.upsert({
    where: {
      runtimeEnvironmentId_name: { runtimeEnvironmentId: environment.id, name: `task/${SLUG}` },
    },
    create: {
      friendlyId: `queue_${id}`,
      name: `task/${SLUG}`,
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
    },
    update: {},
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${id}`,
      slug: SLUG,
      filePath: "src/task.ts",
      exportName: "task",
      workerId: worker.id,
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      queueId: queue.id,
    },
  });
  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${id}`,
      shortCode: id,
      contentHash: id,
      version: options.version,
      projectId: environment.project.id,
      environmentId: environment.id,
      status: "DEPLOYED",
      imageReference: IMAGE,
      workerId: worker.id,
      templateKey: options.templateKey,
    },
  });
  return { worker, deployment };
}

function newCache(redisOptions: ConstructorParameters<typeof Redis>[0]) {
  const redis = new Redis(redisOptions as any);
  onTestFinished(() => redis.quit());
  return new RedisTaskMetadataCache({ redis });
}

const migratedOrg = {
  baseWorkerQueue: "us-east-1",
  baseEnableFastPath: false,
  region: "us-east-1",
  backing: { workerQueue: "us-east-1-next", enableFastPath: true },
  planType: "free",
  orgId: "org_x",
  orgFeatureFlags: { computeMigrationEnabled: true },
  flags: undefined,
  envType: "PRODUCTION",
  environmentCompat: undefined,
};

async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, message: string) {
  const deadline = performance.now() + 5_000;
  let value = await read();
  while (!done(value) && performance.now() < deadline) {
    await setTimeout(20);
    value = await read();
  }
  expect(done(value), message).toBe(true);
  return value;
}

async function withBuilder(templateId: string, run: (url: string) => Promise<void>) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ template_id: templateId, template_source: "built" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function builderConfig(url: string) {
  return {
    url,
    timeoutMs: 5_000,
    presets: ["small-1x" as const],
    shadowRolloutPct: 0,
    mixedRuntimeWorkerGroups: [],
  };
}

describe("template key in the task metadata cache", () => {
  containerTest(
    "a keyed promotion copies the key into the env hash, and the run stays on compute",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { worker, deployment } = await createDeployment(prisma, environment, {
        templateKey: KEY,
        version: "20260101.1",
      });
      const cache = newCache(redisOptions);

      await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(deployment, "promote");

      expect((await cache.getCurrent(environment.id, SLUG))?.templateKey).toBe(KEY);
      expect((await cache.getByWorker(worker.id, SLUG))?.templateKey).toBe(KEY);

      const queues = new DefaultQueueManager(prisma, noEngine, undefined, cache);
      const { templateKey } = await queues.resolveQueueProperties({
        taskId: SLUG,
        environment,
        body: { payload: {} },
      } as any);
      expect(templateKey).toBe(KEY);
      expect(resolveComputeMigration({ ...migratedOrg, templateKey }).workerQueue).toBe(
        "us-east-1-next"
      );
    }
  );

  containerTest(
    "a keyless promotion keeps a migrated org's run on the base queue",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { deployment } = await createDeployment(prisma, environment, {
        version: "20260101.1",
      });
      const cache = newCache(redisOptions);

      await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(deployment, "promote");

      const queues = new DefaultQueueManager(prisma, noEngine, undefined, cache);
      const { templateKey } = await queues.resolveQueueProperties({
        taskId: SLUG,
        environment,
        body: { payload: {} },
      } as any);
      expect(templateKey ?? null).toBeNull();
      expect(resolveComputeMigration({ ...migratedOrg, templateKey }).workerQueue).toBe(
        "us-east-1"
      );
    }
  );

  containerTest(
    "a keyless promotion births a canary-channel migrated run on the stable container queue",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { deployment } = await createDeployment(prisma, environment, {
        version: "20260101.1",
      });
      const cache = newCache(redisOptions);
      await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(deployment, "promote");

      const queues = new DefaultQueueManager(prisma, noEngine, undefined, cache);
      const { templateKey } = await queues.resolveQueueProperties({
        taskId: SLUG,
        environment,
        body: { payload: {} },
      } as any);
      const orgFeatureFlags = { ...migratedOrg.orgFeatureFlags, workerQueueChannel: "canary" };
      const migrated = resolveComputeMigration({ ...migratedOrg, orgFeatureFlags, templateKey });
      const birth = workerQueueForBirth({
        workerQueue: migrated.workerQueue!,
        region: migrated.region,
        envType: "PRODUCTION",
        orgFeatureFlags,
        environmentOverride: {},
        v2Enabled: true,
        splitEnabled: false,
        workerGroups: [
          { masterQueue: "us-east-1", workloadType: "CONTAINER" },
          { masterQueue: "us-east-1-next", workloadType: "MICROVM" },
        ],
        rootTriggerSource: "api",
        templateFallback: migrated.templateFallback,
        anyCompatAllowed: allowsAnyCompat({ ...migratedOrg, orgFeatureFlags, templateKey }),
      });
      // Container consumers take only stable, so a canary container queue would strand the run.
      expect(birth).toBe("us-east-1:v2:ondemand:fresh:container:stable");
    }
  );

  containerTest(
    "a late build stamps its own worker's hashes but not a newer promotion's env hash",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const older = await createDeployment(prisma, environment, { version: "20260101.1" });
      const newer = await createDeployment(prisma, environment, {
        templateKey: NEWER_KEY,
        version: "20260101.2",
      });
      const cache = newCache(redisOptions);
      const promotions = new ChangeCurrentDeploymentService(prisma, prisma, cache);
      await promotions.call(older.deployment, "promote");
      await promotions.call(newer.deployment, "promote");

      await withBuilder(KEY, async (url) => {
        const service = new TemplatePrebuildService(prisma, builderConfig(url), cache);
        expect(await service.build(IMAGE, "shadow", older.deployment)).toEqual({
          outcome: "built",
        });
      });

      const stored = await prisma.workerDeployment.findFirst({
        where: { id: older.deployment.id },
        select: { templateKey: true },
      });
      expect(stored?.templateKey).toBe(KEY);
      expect((await cache.getByWorker(older.worker.id, SLUG))?.templateKey).toBe(KEY);
      expect((await cache.getCurrent(environment.id, SLUG))?.templateKey).toBe(NEWER_KEY);
    }
  );

  containerTest("a slow cache does not turn a stored key into a timeout", async ({ prisma }) => {
    db.client = prisma;
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const { deployment } = await createDeployment(prisma, environment, {
      version: "20260101.1",
    });
    // A Redis peer that accepts connections and never answers.
    const sockets: Socket[] = [];
    const silent = createTcpServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const redis = new Redis({
      host: "127.0.0.1",
      port: (silent.address() as AddressInfo).port,
      maxRetriesPerRequest: null,
    });
    onTestFinished(async () => {
      redis.disconnect();
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const cache = new RedisTaskMetadataCache({ redis });

    await withBuilder(KEY, async (url) => {
      const service = new TemplatePrebuildService(
        prisma,
        { ...builderConfig(url), timeoutMs: 1_000 },
        cache
      );
      const startedAt = performance.now();
      expect(await service.build(IMAGE, "shadow", deployment)).toEqual({ outcome: "built" });
      expect(performance.now() - startedAt).toBeLessThan(5_000);
    });

    const stored = await prisma.workerDeployment.findFirst({
      where: { id: deployment.id },
      select: { templateKey: true },
    });
    expect(stored?.templateKey).toBe(KEY);
  });

  containerTest(
    "a promotion keeps a key that a build stored after the promotion read the row",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { worker, deployment } = await createDeployment(prisma, environment, {
        version: "20260101.1",
      });
      const cache = newCache(redisOptions);

      // The build finishes first: the row and the by-worker hash get the key, and the env hash
      // is skipped because this worker does not own it yet.
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: { templateKey: KEY },
      });
      await cache.setTemplateKey(environment.id, worker.id, KEY);

      // The promotion still holds the row it read before the build.
      await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(deployment, "promote");

      expect((await cache.getCurrent(environment.id, SLUG))?.templateKey).toBe(KEY);
      expect((await cache.getByWorker(worker.id, SLUG))?.templateKey).toBe(KEY);
    }
  );

  containerTest(
    "a build for the current deployment stamps the env hash",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { worker, deployment } = await createDeployment(prisma, environment, {
        version: "20260101.1",
      });
      const cache = newCache(redisOptions);
      await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(deployment, "promote");
      expect((await cache.getCurrent(environment.id, SLUG))?.templateKey).toBeNull();

      await withBuilder(KEY, async (url) => {
        const service = new TemplatePrebuildService(prisma, builderConfig(url), cache);
        expect(await service.build(IMAGE, "shadow", deployment)).toEqual({ outcome: "built" });
      });

      expect((await cache.getCurrent(environment.id, SLUG))?.templateKey).toBe(KEY);
      expect((await cache.getByWorker(worker.id, SLUG))?.templateKey).toBe(KEY);
    }
  );

  containerTest(
    "a cold read back-fills the key into both hashes",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { worker, deployment } = await createDeployment(prisma, environment, {
        templateKey: KEY,
        version: "20260101.1",
      });
      await prisma.workerDeploymentPromotion.create({
        data: { label: "current", deploymentId: deployment.id, environmentId: environment.id },
      });
      const cache = newCache(redisOptions);
      expect(await cache.getCurrent(environment.id, SLUG)).toBeNull();

      const queues = new DefaultQueueManager(prisma, noEngine, undefined, cache);
      const { templateKey } = await queues.resolveQueueProperties({
        taskId: SLUG,
        environment,
        body: { payload: {} },
      } as any);
      expect(templateKey).toBe(KEY);

      await pollFor(
        () => cache.getCurrent(environment.id, SLUG),
        (entry) => entry?.templateKey === KEY,
        "the env hash never got the back-filled key"
      );
      expect((await cache.getByWorker(worker.id, SLUG))?.templateKey).toBe(KEY);
    }
  );

  containerTest(
    "the locked-version path reads the key from the by-worker hash",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const locked = await createDeployment(prisma, environment, {
        templateKey: KEY,
        version: "20260101.1",
      });
      const current = await createDeployment(prisma, environment, { version: "20260101.2" });
      const cache = newCache(redisOptions);
      await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(
        current.deployment,
        "promote"
      );
      const queues = new DefaultQueueManager(prisma, noEngine, undefined, cache);
      const request = { taskId: SLUG, environment, body: { payload: {} } } as any;

      // Cold by-worker hash: the locked read falls back to the row and back-fills the key.
      const cold = await queues.resolveQueueProperties(request, locked.worker);
      expect(cold.templateKey).toBe(KEY);
      await pollFor(
        () => cache.getByWorker(locked.worker.id, SLUG),
        (entry) => entry?.templateKey === KEY,
        "the by-worker hash never got the back-filled key"
      );

      // Warm by-worker hash: the cached key wins over the row, and the env hash is not read.
      const entry = await cache.getByWorker(locked.worker.id, SLUG);
      await cache.setByWorker(locked.worker.id, entry!, NEWER_KEY);
      const warm = await queues.resolveQueueProperties(request, locked.worker);
      expect(warm.templateKey).toBe(NEWER_KEY);
      expect((await queues.resolveQueueProperties(request)).templateKey ?? null).toBeNull();
    }
  );
});

describe("a mixed-runtime group as its region's compute backing", () => {
  const COMPUTE = "us-east-1:v2:ondemand:fresh:compute:stable";
  const CONTAINER = "us-east-1:v2:ondemand:fresh:container:stable";

  // One CONTAINER group carries both runtimes; the old MICROVM group is hidden unless asked.
  async function setupRegion(
    prisma: PrismaClient,
    options: { migrated: boolean; visibleMicrovm?: boolean }
  ) {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const group = (masterQueue: string, workloadType: "CONTAINER" | "MICROVM", hidden: boolean) =>
      prisma.workerInstanceGroup.create({
        data: {
          name: masterQueue,
          masterQueue,
          region: "us-east-1",
          type: "MANAGED",
          workloadType,
          hidden,
          token: { create: { tokenHash: `token_${masterQueue}` } },
        },
      });
    const mixed = await group("cme-mixed", "CONTAINER", false);
    await group("us-east-1-mvm", "MICROVM", !options.visibleMicrovm);
    await prisma.project.update({
      where: { id: environment.project.id },
      data: { defaultWorkerGroupId: mixed.id },
    });
    await prisma.organization.update({
      where: { id: environment.organization.id },
      data: { featureFlags: { computeMigrationEnabled: options.migrated } },
    });
    await workerRegionRegistry.reload();
    return { environment, mixed };
  }

  // The trigger path from the default worker group to the queue a run is born on.
  async function birthQueue(
    prisma: PrismaClient,
    redisOptions: ConstructorParameters<typeof Redis>[0],
    environment: Environment,
    mixedRuntimeWorkerGroups: string[],
    templateKey: string | undefined,
    v2Enabled = true
  ) {
    const { deployment } = await createDeployment(prisma, environment, {
      templateKey,
      version: "20260101.1",
    });
    const cache = newCache(redisOptions);
    await new ChangeCurrentDeploymentService(prisma, prisma, cache).call(deployment, "promote");
    const queues = new DefaultQueueManager(prisma, noEngine, undefined, cache);
    const properties = await queues.resolveQueueProperties({
      taskId: SLUG,
      environment,
      body: { payload: {} },
    } as any);
    const base = await queues.getWorkerQueue(environment as any);
    const organization = await prisma.organization.findFirstOrThrow({
      where: { id: environment.organization.id },
    });
    const orgFeatureFlags = organization.featureFlags as Record<string, unknown>;
    const workerGroups = workerRegionRegistry.current() ?? [];
    const decision = {
      planType: "free",
      orgId: organization.id,
      orgFeatureFlags,
      flags: undefined,
      templateKey: properties.templateKey,
    };
    const migrated = resolveComputeMigration({
      ...decision,
      baseWorkerQueue: base!.masterQueue,
      baseEnableFastPath: base!.enableFastPath,
      region: regionForQueue(base!.masterQueue, workerGroups),
      backing: backingForQueue(
        base!.masterQueue,
        workerGroups,
        selfBackingWorkerGroups(mixedRuntimeWorkerGroups, v2Enabled)
      ),
      envType: "PRODUCTION",
      environmentCompat: undefined,
    });
    if (!v2Enabled) return migrated.workerQueue;
    return workerQueueForBirth({
      workerQueue: migrated.workerQueue!,
      region: migrated.region,
      envType: "PRODUCTION",
      orgFeatureFlags,
      environmentOverride: {},
      v2Enabled,
      splitEnabled: false,
      workerGroups,
      rootTriggerSource: "api",
      templateFallback: migrated.templateFallback,
      compute: migrated.compute,
      anyCompatAllowed: allowsAnyCompat(decision),
    });
  }

  function prebuildMode(prisma: PrismaClient, projectId: string, mixed: string[]) {
    const config = { ...builderConfig("http://127.0.0.1:1"), mixedRuntimeWorkerGroups: mixed };
    return new TemplatePrebuildService(prisma, config).resolveMode(projectId);
  }

  containerTest(
    "a migrated org on a listed group is eligible and routes keyed runs to compute",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const { environment, mixed } = await setupRegion(prisma, { migrated: true });

      expect(await prebuildMode(prisma, environment.project.id, [mixed.id])).toEqual({
        mode: "shadow",
        reason: "migrated",
      });
      expect(await birthQueue(prisma, redisOptions, environment, [mixed.id], KEY)).toBe(COMPUTE);
    }
  );

  containerTest(
    "a migrated org's keyless run on a listed group stays on containers",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const { environment, mixed } = await setupRegion(prisma, { migrated: true });

      expect(await birthQueue(prisma, redisOptions, environment, [mixed.id], undefined)).toBe(
        CONTAINER
      );
    }
  );

  containerTest(
    "a non-migrated org on a listed group is unchanged",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const { environment, mixed } = await setupRegion(prisma, { migrated: false });

      expect(await prebuildMode(prisma, environment.project.id, [mixed.id])).toEqual({
        mode: "skip",
        reason: "none",
      });
      expect(await birthQueue(prisma, redisOptions, environment, [mixed.id], KEY)).toBe(CONTAINER);
    }
  );

  containerTest(
    "a group not on the list is not its own backing",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const { environment } = await setupRegion(prisma, { migrated: true });

      expect(await prebuildMode(prisma, environment.project.id, [])).toEqual({
        mode: "skip",
        reason: "none",
      });
      expect(await birthQueue(prisma, redisOptions, environment, [], KEY)).toBe(CONTAINER);
    }
  );

  containerTest(
    "with v2 queues off, a listed group is not its own backing",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const { environment, mixed } = await setupRegion(prisma, { migrated: true });

      expect(
        await prebuildMode(prisma, environment.project.id, [
          ...selfBackingWorkerGroups([mixed.id], false),
        ])
      ).toEqual({ mode: "skip", reason: "none" });
      expect(await birthQueue(prisma, redisOptions, environment, [mixed.id], KEY, false)).toBe(
        "cme-mixed"
      );
    }
  );

  containerTest(
    "a visible MICROVM group in the region stays the backing",
    async ({ prisma, redisOptions }) => {
      db.client = prisma;
      const { environment, mixed } = await setupRegion(prisma, {
        migrated: true,
        visibleMicrovm: true,
      });
      const workerGroups = workerRegionRegistry.current() ?? [];

      for (const listed of [[], [mixed.id]]) {
        expect(backingForQueue("cme-mixed", workerGroups, listed)).toEqual({
          workerQueue: "us-east-1-mvm",
          enableFastPath: false,
        });
        expect(await prebuildMode(prisma, environment.project.id, listed)).toEqual({
          mode: "shadow",
          reason: "migrated",
        });
      }
      expect(await birthQueue(prisma, redisOptions, environment, [], KEY)).toBe(COMPUTE);
    }
  );
});
