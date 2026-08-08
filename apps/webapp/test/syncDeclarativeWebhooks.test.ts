import { containerTest } from "@internal/testcontainers";
import type { WebhookResource } from "@trigger.dev/core/v3";
import type { BackgroundWorker, PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { syncDeclarativeWebhooks } from "~/v3/services/createBackgroundWorker.server";

vi.setConfig({ testTimeout: 60_000 });

type WorkerArg = Parameters<typeof syncDeclarativeWebhooks>[1];
const noWorker = {} as unknown as WorkerArg;

async function seedProjectWithEnv(prisma: PrismaClient) {
  const slug = `sdw_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `p${slug.slice(0, 5)}`,
    },
  });
  return { organization, project, environment };
}

async function seedWorkerWithTask(
  prisma: PrismaClient,
  project: { id: string },
  environment: { id: string },
  taskSlug: string
): Promise<BackgroundWorker> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${suffix}`,
      contentHash: `hash_${suffix}`,
      version: "20260101.1",
      metadata: {},
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
    },
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${suffix}`,
      slug: taskSlug,
      filePath: `src/trigger/${taskSlug}.ts`,
      workerId: worker.id,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
    },
  });
  return worker;
}

async function seedEndpoint(
  prisma: PrismaClient,
  base: { organizationId: string; projectId: string; runtimeEnvironmentId: string },
  handlerWebhookId: string,
  status: "ACTIVE" | "INACTIVE"
) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return prisma.webhookEndpoint.create({
    data: {
      friendlyId: `wh_${suffix}`,
      opaqueId: `op_${suffix}${Math.random().toString(36).slice(2, 10)}`,
      organizationId: base.organizationId,
      projectId: base.projectId,
      runtimeEnvironmentId: base.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      source: "stripe",
      handlerWebhookId,
      routingTarget: { type: "task", taskId: "handle-stripe" },
      verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
      status,
    },
  });
}

function makeWebhookResource(id: string, taskId: string): WebhookResource {
  return {
    id,
    filePath: `src/trigger/${id}.ts`,
    source: "stripe",
    verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
    routingTarget: { type: "task", taskId },
  };
}

const asEnv = (env: unknown) => env as AuthenticatedEnvironment;

describe("syncDeclarativeWebhooks status reconciliation", () => {
  containerTest(
    "an absent webhooks list (older client) does not deactivate existing endpoints",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedProjectWithEnv(prisma);
      const endpoint = await seedEndpoint(
        prisma,
        {
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
        "declared-webhook",
        "ACTIVE"
      );

      await syncDeclarativeWebhooks(undefined, noWorker, asEnv(environment), prisma, prisma);

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(after.status).toBe("ACTIVE");
    }
  );

  containerTest(
    "an explicit empty list deactivates endpoints that are no longer declared",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedProjectWithEnv(prisma);
      const endpoint = await seedEndpoint(
        prisma,
        {
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
        "declared-webhook",
        "ACTIVE"
      );

      await syncDeclarativeWebhooks([], noWorker, asEnv(environment), prisma, prisma);

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(after.status).toBe("INACTIVE");
    }
  );

  containerTest(
    "a redeploy does not re-activate an endpoint disabled via the API",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedProjectWithEnv(prisma);
      const worker = await seedWorkerWithTask(prisma, project, environment, "handle-stripe");
      const endpoint = await seedEndpoint(
        prisma,
        {
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
        "declared-webhook",
        "INACTIVE"
      );

      await syncDeclarativeWebhooks(
        [makeWebhookResource("declared-webhook", "handle-stripe")],
        worker,
        asEnv(environment),
        prisma,
        prisma
      );

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(after.status).toBe("INACTIVE");
    }
  );

  containerTest("a newly declared webhook creates an active endpoint", async ({ prisma }) => {
    const { project, environment } = await seedProjectWithEnv(prisma);
    const worker = await seedWorkerWithTask(prisma, project, environment, "handle-stripe");

    await syncDeclarativeWebhooks(
      [makeWebhookResource("brand-new-webhook", "handle-stripe")],
      worker,
      asEnv(environment),
      prisma,
      prisma
    );

    const created = await prisma.webhookEndpoint.findFirst({
      where: { runtimeEnvironmentId: environment.id, handlerWebhookId: "brand-new-webhook" },
    });
    expect(created?.status).toBe("ACTIVE");
  });
});
