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
