import { describe, expect, vi } from "vitest";

const db = vi.hoisted(() => ({ client: undefined as any }));
vi.mock("~/db.server", async (importOriginal) => {
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
    ...(await importOriginal<Record<string, unknown>>()),
    prisma: client,
    $replica: client,
    webhookPrisma: client,
    runOpsNewPrisma: client,
    runOpsLegacyPrisma: client,
  };
});
import { containerTest } from "@internal/testcontainers";
import type {
  BackgroundWorkerMetadata,
  WebhookEndpointResource,
  WebhookSubscriberResource,
} from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { $transaction } from "~/db.server";
import { NoopTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";
import { stripBackgroundWorkerMetadataForStorage } from "~/v3/services/stripBackgroundWorkerMetadataForStorage.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Webhooks = Pick<BackgroundWorkerMetadata, "webhookEndpoints" | "webhookSubscribers">;

async function seedEnvironment(prisma: PrismaClient) {
  const slug = `ccdw_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({
    data: { title: slug, slug, featureFlags: { hasWebhooksAccess: true } },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  return prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(5, 10)}`,
    },
  });
}

async function seedDeployment(
  prisma: PrismaClient,
  environment: { id: string; projectId: string },
  version: string,
  taskSlugs: string[],
  webhooks: Webhooks
) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const metadata: BackgroundWorkerMetadata = {
    packageVersion: "4.8.0",
    contentHash: `hash_${suffix}`,
    tasks: [],
    ...webhooks,
  };
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${suffix}`,
      contentHash: `hash_${suffix}`,
      version,
      metadata: stripBackgroundWorkerMetadataForStorage(metadata),
      projectId: environment.projectId,
      runtimeEnvironmentId: environment.id,
    },
  });
  for (const slug of taskSlugs) {
    await prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: `task_${suffix}_${slug}`,
        slug,
        filePath: `src/trigger/${slug}.ts`,
        workerId: worker.id,
        projectId: environment.projectId,
        runtimeEnvironmentId: environment.id,
      },
    });
  }
  return prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${suffix}`,
      shortCode: suffix,
      contentHash: `hash_${suffix}`,
      version,
      projectId: environment.projectId,
      environmentId: environment.id,
      status: "DEPLOYED",
      workerId: worker.id,
    },
  });
}

function endpoint(id: string): WebhookEndpointResource {
  return {
    id,
    filePath: `src/trigger/${id}.ts`,
    source: "stripe",
    verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
  };
}

function subscriber(endpointId: string, taskId: string): WebhookSubscriberResource {
  return { endpointId, target: { type: "task", id: taskId, taskId } };
}

function service(prisma: PrismaClient) {
  db.client = prisma;
  return new ChangeCurrentDeploymentService(prisma, prisma, new NoopTaskMetadataCache());
}

async function endpointsByDeclaredId(prisma: PrismaClient, environmentId: string) {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { runtimeEnvironmentId: environmentId },
  });
  return Object.fromEntries(
    rows.map((row) => [
      row.declaredId,
      {
        status: row.status,
        tasks: (row.routingTargets as Array<{ taskId: string }>).map((t) => t.taskId),
      },
    ])
  );
}

describe("ChangeCurrentDeploymentService webhook endpoints", () => {
  containerTest("a rollback restores the older worker's routing targets", async ({ prisma }) => {
    const environment = await seedEnvironment(prisma);
    const older = await seedDeployment(prisma, environment, "20260101.1", ["orders"], {
      webhookEndpoints: [endpoint("stripe")],
      webhookSubscribers: [subscriber("stripe", "orders")],
    });
    const newer = await seedDeployment(prisma, environment, "20260101.2", ["orders-v2"], {
      webhookEndpoints: [endpoint("stripe")],
      webhookSubscribers: [subscriber("stripe", "orders-v2")],
    });

    await service(prisma).call(older, "promote");
    await service(prisma).call(newer, "promote");
    expect(await endpointsByDeclaredId(prisma, environment.id)).toEqual({
      stripe: { status: "ACTIVE", tasks: ["orders-v2"] },
    });

    await service(prisma).call(older, "rollback");
    expect(await endpointsByDeclaredId(prisma, environment.id)).toEqual({
      stripe: { status: "ACTIVE", tasks: ["orders"] },
    });

    await service(prisma).call(newer, "promote");
    expect(await endpointsByDeclaredId(prisma, environment.id)).toEqual({
      stripe: { status: "ACTIVE", tasks: ["orders-v2"] },
    });
  });

  containerTest(
    "a rollback deactivates an endpoint the older worker doesn't declare",
    async ({ prisma }) => {
      const environment = await seedEnvironment(prisma);
      const older = await seedDeployment(prisma, environment, "20260101.1", ["orders"], {
        webhookEndpoints: [endpoint("stripe")],
        webhookSubscribers: [subscriber("stripe", "orders")],
      });
      const newer = await seedDeployment(prisma, environment, "20260101.2", ["orders", "repos"], {
        webhookEndpoints: [endpoint("stripe"), endpoint("github")],
        webhookSubscribers: [subscriber("stripe", "orders"), subscriber("github", "repos")],
      });

      await service(prisma).call(older, "promote");
      await service(prisma).call(newer, "promote");
      expect(await endpointsByDeclaredId(prisma, environment.id)).toEqual({
        stripe: { status: "ACTIVE", tasks: ["orders"] },
        github: { status: "ACTIVE", tasks: ["repos"] },
      });

      await service(prisma).call(older, "rollback");
      expect(await endpointsByDeclaredId(prisma, environment.id)).toEqual({
        stripe: { status: "ACTIVE", tasks: ["orders"] },
        github: { status: "INACTIVE", tasks: ["repos"] },
      });

      await service(prisma).call(newer, "promote");
      expect((await endpointsByDeclaredId(prisma, environment.id)).github?.status).toBe("ACTIVE");
    }
  );

  containerTest(
    "a rollback to a worker stored without webhook declarations leaves the endpoints alone",
    async ({ prisma }) => {
      const environment = await seedEnvironment(prisma);
      const older = await seedDeployment(prisma, environment, "20260101.1", ["orders"], {});
      const newer = await seedDeployment(prisma, environment, "20260101.2", ["orders-v2"], {
        webhookEndpoints: [endpoint("stripe")],
        webhookSubscribers: [subscriber("stripe", "orders-v2")],
      });

      await service(prisma).call(newer, "promote");
      await service(prisma).call(older, "rollback");

      expect(await endpointsByDeclaredId(prisma, environment.id)).toEqual({
        stripe: { status: "ACTIVE", tasks: ["orders-v2"] },
      });
    }
  );
});

describe("ChangeCurrentDeploymentService for compute-only organizations", () => {
  // Catches: a compute-only organization rolling back to a version deployed without a compute
  // template, after which every trigger of the environment fails.
  containerTest(
    "refuses a version without a compute template and still allows one with a template",
    async ({ prisma }) => {
      const environment = await seedEnvironment(prisma);
      const none: Webhooks = { webhookEndpoints: [], webhookSubscribers: [] };
      const keyless = await seedDeployment(prisma, environment, "20260101.1", ["a"], none);
      const keyed = await prisma.workerDeployment.update({
        where: { id: (await seedDeployment(prisma, environment, "20260101.2", ["a"], none)).id },
        data: { templateKey: "a".repeat(64) },
      });
      await prisma.organization.update({
        where: { id: environment.organizationId },
        data: { featureFlags: { computeOnly: true } },
      });

      await service(prisma).call(keyed, "promote");
      await expect(service(prisma).call(keyless, "rollback")).rejects.toThrow(
        "Version 20260101.1 can't be made current. Deploy a new version instead."
      );

      const current = await prisma.workerDeploymentPromotion.findFirst({
        where: { environmentId: environment.id },
        select: { deploymentId: true },
      });
      expect(current?.deploymentId).toBe(keyed.id);

      // Once the organization isn't compute-only, the same rollback goes through.
      await prisma.organization.update({
        where: { id: environment.organizationId },
        data: { featureFlags: {} },
      });
      // The flags a caller passes are used instead of a read: the stored ones no longer say compute-only.
      await expect(
        service(prisma).call(keyless, "rollback", {
          organizationFeatureFlags: { computeOnly: true },
        })
      ).rejects.toThrow("Deploy a new version instead.");
      await service(prisma).call(keyless, "rollback");
    }
  );
});

describe("ChangeCurrentDeploymentService with an expected current deployment", () => {
  // Catches: a switch approved against one current deployment replacing another that became current since.
  containerTest("only switches while the expected deployment is current", async ({ prisma }) => {
    const environment = await seedEnvironment(prisma);
    const none: Webhooks = { webhookEndpoints: [], webhookSubscribers: [] };
    const shown = await seedDeployment(prisma, environment, "20260101.1", ["a"], none);
    const raced = await seedDeployment(prisma, environment, "20260101.2", ["a"], none);
    const target = await seedDeployment(prisma, environment, "20260101.3", ["a"], none);
    const currentId = async () =>
      (
        await prisma.workerDeploymentPromotion.findFirst({
          where: { environmentId: environment.id },
        })
      )?.deploymentId;

    await service(prisma).call(shown, "promote");
    await service(prisma).call(raced, "promote");

    for (const expected of [shown.id, null]) {
      expect(
        await service(prisma).call(target, "promote", { expectedCurrentDeploymentId: expected })
      ).toEqual({ stale: true });
      expect(await currentId()).toBe(raced.id);
    }

    expect(
      (await service(prisma).call(target, "promote", { expectedCurrentDeploymentId: raced.id }))
        .stale
    ).toBeUndefined();
    expect(await currentId()).toBe(target.id);
  });

  // Catches: the switch written unconditionally after the early check, so a rival switch committed
  // while it waited is replaced and the skew protection thresholds above the target are cleared.
  containerTest(
    "misses at the write when a rival switch lands after the check",
    async ({ prisma }) => {
      const environment = await seedEnvironment(prisma);
      const none: Webhooks = { webhookEndpoints: [], webhookSubscribers: [] };
      const shown = await seedDeployment(prisma, environment, "20260101.1", ["a"], none);
      const raced = await seedDeployment(prisma, environment, "20260101.2", ["a"], none);
      const target = await seedDeployment(prisma, environment, "20260101.3", ["a"], none);
      await service(prisma).call(shown, "promote");
      const thresholds = {
        environment: { version: "20260101.9", setAt: "2026-01-01T00:00:00.000Z" },
      };
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { skewProtectionThresholds: thresholds },
      });

      const started = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const rival = $transaction(
        prisma,
        "rival switch",
        async (tx) => {
          await tx.workerDeploymentPromotion.updateMany({
            where: { environmentId: environment.id },
            data: { deploymentId: raced.id },
          });
          const [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
          started.resolve(pid);
          await release.promise;
        },
        { timeout: 30_000 }
      );
      try {
        const pid = await started.promise;
        const switched = service(prisma).call(target, "promote", {
          expectedCurrentDeploymentId: shown.id,
        });
        const deadline = Date.now() + 15_000;
        for (;;) {
          const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
          if (waiting > 0) break;
          if (Date.now() > deadline) throw new Error("the switch never waited on the rival");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        release.resolve();
        await rival;

        expect(await switched).toEqual({ stale: true });
      } finally {
        release.resolve();
        await rival;
      }
      const after = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
        select: { skewProtectionThresholds: true },
      });
      expect({
        current: (
          await prisma.workerDeploymentPromotion.findFirst({
            where: { environmentId: environment.id },
          })
        )?.deploymentId,
        thresholds: after.skewProtectionThresholds,
      }).toEqual({ current: raced.id, thresholds });
    }
  );

  // Catches: a threshold expectation on a caller's transaction, where a stale answer couldn't undo the pointer write.
  containerTest("refuses a threshold expectation on a caller's transaction", async ({ prisma }) => {
    const environment = await seedEnvironment(prisma);
    const none: Webhooks = { webhookEndpoints: [], webhookSubscribers: [] };
    const target = await seedDeployment(prisma, environment, "20260101.1", ["a"], none);
    const outcome = await $transaction(prisma, "caller transaction", async (tx) =>
      new ChangeCurrentDeploymentService(tx, tx, new NoopTaskMetadataCache())
        .call(target, "promote", { expectedClearedThresholds: { tasks: [] } })
        .then(
          () => "switched",
          () => "refused"
        )
    );
    expect(outcome).toBe("refused");
    expect(
      await prisma.workerDeploymentPromotion.findFirst({ where: { environmentId: environment.id } })
    ).toBeNull();
  });

  // Catches: the threshold check locking the environment row before the pointer, the reverse of
  // every other switch, which can deadlock against a Dashboard rollback.
  containerTest("takes the pointer lock before the environment row lock", async ({ prisma }) => {
    const environment = await seedEnvironment(prisma);
    const none: Webhooks = { webhookEndpoints: [], webhookSubscribers: [] };
    const shown = await seedDeployment(prisma, environment, "20260101.1", ["a"], none);
    const target = await seedDeployment(prisma, environment, "20260101.2", ["a"], none);
    await service(prisma).call(shown, "promote");

    const started = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const pointerHeld = $transaction(
      prisma,
      "hold the pointer",
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "WorkerDeploymentPromotion" WHERE "environmentId" = ${environment.id} FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
        started.resolve(pid);
        await release.promise;
      },
      { timeout: 30_000 }
    );
    try {
      const pid = await started.promise;
      const switched = service(prisma).call(target, "promote", {
        expectedCurrentDeploymentId: shown.id,
        expectedClearedThresholds: { tasks: [] },
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error("the switch never waited on the pointer");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // While it waits on the pointer it must not hold the environment row.
      const probe = await $transaction(prisma, "probe the environment row", async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "RuntimeEnvironment" WHERE "id" = ${environment.id} FOR NO KEY UPDATE NOWAIT`;
        return "free";
      }).catch(() => "locked");
      expect(probe).toBe("free");

      release.resolve();
      await pointerHeld;
      expect((await switched).stale).toBeUndefined();
    } finally {
      release.resolve();
      await pointerHeld;
    }
    expect(
      (
        await prisma.workerDeploymentPromotion.findFirst({
          where: { environmentId: environment.id },
        })
      )?.deploymentId
    ).toBe(target.id);
  });
});
