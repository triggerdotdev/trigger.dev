import { containerTest } from "@internal/testcontainers";
import type { WebhookEndpointResource, WebhookSubscriberResource } from "@trigger.dev/core/v3";
import type { BackgroundWorker, PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  MAX_WEBHOOK_SUBSCRIBERS_PER_ENDPOINT,
  syncDeclarativeWebhooks,
} from "~/v3/services/createBackgroundWorker.server";

vi.setConfig({ testTimeout: 60_000 });

type WorkerArg = Parameters<typeof syncDeclarativeWebhooks>[1];
const noWorker = {} as unknown as WorkerArg;

async function seedProjectWithEnv(prisma: PrismaClient) {
  const slug = `sdw_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({
    data: { title: slug, slug, featureFlags: { hasWebhooksAccess: true } },
  });
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
  declaredId: string,
  status: "ACTIVE" | "INACTIVE",
  manuallyDeactivatedAt: Date | null = null
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
      declaredId,
      routingTargets: [{ type: "task", id: "handle-stripe", taskId: "handle-stripe" }],
      verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
      status,
      manuallyDeactivatedAt,
    },
  });
}

function makeEndpointResource(id: string): WebhookEndpointResource {
  return {
    id,
    filePath: `src/trigger/${id}.ts`,
    source: "stripe",
    verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
  };
}

function taskSubscriber(
  endpointId: string,
  taskId: string,
  filter?: string
): WebhookSubscriberResource {
  return {
    endpointId,
    target: { type: "task", id: taskId, taskId, ...(filter ? { filter } : {}) },
  };
}

function declaredWebhook(endpointId: string, taskId: string) {
  return {
    endpoints: [makeEndpointResource(endpointId)],
    subscribers: [taskSubscriber(endpointId, taskId)],
  };
}

const asEnv = (env: unknown) => env as AuthenticatedEnvironment;

describe("syncDeclarativeWebhooks status reconciliation", () => {
  containerTest(
    "an org without webhooks access syncs no endpoints and leaves existing ones alone",
    async ({ prisma }) => {
      const { organization, project, environment } = await seedProjectWithEnv(prisma);
      await prisma.organization.update({
        where: { id: organization.id },
        data: { featureFlags: {} },
      });
      const worker = await seedWorkerWithTask(prisma, project, environment, "handle-stripe");
      const existing = await seedEndpoint(
        prisma,
        {
          organizationId: organization.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
        "existing-webhook",
        "ACTIVE"
      );

      await syncDeclarativeWebhooks(
        declaredWebhook("declared-webhook", "handle-stripe"),
        worker,
        asEnv(environment),
        prisma,
        prisma
      );

      const endpoints = await prisma.webhookEndpoint.findMany({
        where: { runtimeEnvironmentId: environment.id },
      });
      expect(endpoints.map((e) => [e.id, e.status])).toEqual([[existing.id, "ACTIVE"]]);
    }
  );

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

      await syncDeclarativeWebhooks(
        { endpoints: undefined, subscribers: undefined },
        noWorker,
        asEnv(environment),
        prisma,
        prisma
      );

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

      await syncDeclarativeWebhooks(
        { endpoints: [], subscribers: [] },
        noWorker,
        asEnv(environment),
        prisma,
        prisma
      );

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
        "INACTIVE",
        new Date()
      );

      await syncDeclarativeWebhooks(
        declaredWebhook("declared-webhook", "handle-stripe"),
        worker,
        asEnv(environment),
        prisma,
        prisma
      );

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(after.status).toBe("INACTIVE");
      expect(after.manuallyDeactivatedAt).not.toBeNull();
    }
  );

  containerTest(
    "a redeploy re-activates an endpoint auto-deactivated when it was removed then re-declared",
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
        "INACTIVE",
        null
      );

      await syncDeclarativeWebhooks(
        declaredWebhook("declared-webhook", "handle-stripe"),
        worker,
        asEnv(environment),
        prisma,
        prisma
      );

      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
      expect(after.status).toBe("ACTIVE");
    }
  );

  containerTest("a newly declared webhook creates an active endpoint", async ({ prisma }) => {
    const { project, environment } = await seedProjectWithEnv(prisma);
    const worker = await seedWorkerWithTask(prisma, project, environment, "handle-stripe");

    await syncDeclarativeWebhooks(
      declaredWebhook("brand-new-webhook", "handle-stripe"),
      worker,
      asEnv(environment),
      prisma,
      prisma
    );

    const created = await prisma.webhookEndpoint.findFirst({
      where: { runtimeEnvironmentId: environment.id, declaredId: "brand-new-webhook" },
    });
    expect(created?.status).toBe("ACTIVE");
  });
});

describe("syncDeclarativeWebhooks shared endpoints", () => {
  containerTest(
    "subscribers naming one endpoint become one row with a routing target each",
    async ({ prisma }) => {
      const { project, environment } = await seedProjectWithEnv(prisma);
      const worker = await seedWorkerWithTask(prisma, project, environment, "orders");
      await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: `task_${Math.random().toString(36).slice(2, 10)}`,
          slug: "agent-x",
          filePath: "src/trigger/agent.ts",
          workerId: worker.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
      });

      await syncDeclarativeWebhooks(
        {
          endpoints: [makeEndpointResource("payments")],
          subscribers: [
            taskSubscriber("payments", "orders", "event.type == 'checkout.session.completed'"),
            {
              endpointId: "payments",
              target: {
                type: "session",
                id: "agent-x:order-events",
                taskIdentifier: "agent-x",
                keyTemplate: "{body.data.object.customer}",
                deliverAs: "action",
                actionType: "order.event",
              },
            },
          ],
        },
        worker,
        asEnv(environment),
        prisma,
        prisma
      );

      const rows = await prisma.webhookEndpoint.findMany({
        where: { runtimeEnvironmentId: environment.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].declaredId).toBe("payments");
      const targets = rows[0].routingTargets as Array<Record<string, unknown>>;
      expect(targets.map((t) => t.id)).toEqual(["orders", "agent-x:order-events"]);
      expect(targets[0]).toMatchObject({
        type: "task",
        taskId: "orders",
        filter: "event.type == 'checkout.session.completed'",
        filterAstVersion: 1,
      });
      expect(targets[0].filterAst).toBeTruthy();
      expect(targets[1].filterAst).toBeUndefined();
    }
  );

  containerTest(
    "an endpoint with no subscribers still gets a row and a URL",
    async ({ prisma }) => {
      const { environment } = await seedProjectWithEnv(prisma);

      await syncDeclarativeWebhooks(
        { endpoints: [makeEndpointResource("payments")], subscribers: [] },
        noWorker,
        asEnv(environment),
        prisma,
        prisma
      );

      const row = await prisma.webhookEndpoint.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id, declaredId: "payments" },
      });
      expect(row.status).toBe("ACTIVE");
      expect(row.opaqueId.length).toBeGreaterThan(10);
      expect(row.routingTargets).toEqual([]);
    }
  );

  containerTest("an endpoint declared with a wh_ id fails the deploy", async ({ prisma }) => {
    const { project, environment } = await seedProjectWithEnv(prisma);
    const worker = await seedWorkerWithTask(prisma, project, environment, "orders");

    await expect(
      syncDeclarativeWebhooks(
        declaredWebhook("wh_orders", "orders"),
        worker,
        asEnv(environment),
        prisma,
        prisma
      )
    ).rejects.toThrow(/Webhook endpoint id "wh_orders" can't start with "wh_"/);
    expect(
      await prisma.webhookEndpoint.count({ where: { runtimeEnvironmentId: environment.id } })
    ).toBe(0);
  });

  containerTest("a subscriber naming an unknown endpoint fails the deploy", async ({ prisma }) => {
    const { project, environment } = await seedProjectWithEnv(prisma);
    const worker = await seedWorkerWithTask(prisma, project, environment, "orders");

    await expect(
      syncDeclarativeWebhooks(
        {
          endpoints: [makeEndpointResource("payments")],
          subscribers: [taskSubscriber("nope", "orders")],
        },
        worker,
        asEnv(environment),
        prisma,
        prisma
      )
    ).rejects.toThrow(/references unknown endpoint "nope"/);
  });

  containerTest(
    "two subscribers with one id on one endpoint fail the deploy",
    async ({ prisma }) => {
      const { project, environment } = await seedProjectWithEnv(prisma);
      const worker = await seedWorkerWithTask(prisma, project, environment, "orders");

      await expect(
        syncDeclarativeWebhooks(
          {
            endpoints: [makeEndpointResource("payments")],
            subscribers: [
              taskSubscriber("payments", "orders"),
              taskSubscriber("payments", "orders"),
            ],
          },
          worker,
          asEnv(environment),
          prisma,
          prisma
        )
      ).rejects.toThrow(/more than one subscriber with id "orders"/);
    }
  );

  containerTest(
    "more than the subscriber limit on one endpoint fails the deploy",
    async ({ prisma }) => {
      const { environment } = await seedProjectWithEnv(prisma);
      const subscribers = Array.from({ length: MAX_WEBHOOK_SUBSCRIBERS_PER_ENDPOINT + 1 }, (_, i) =>
        taskSubscriber("payments", `task-${i}`)
      );

      await expect(
        syncDeclarativeWebhooks(
          { endpoints: [makeEndpointResource("payments")], subscribers },
          noWorker,
          asEnv(environment),
          prisma,
          prisma
        )
      ).rejects.toThrow(/has 26 subscribers; the limit is 25/);
    }
  );

  containerTest(
    "a subscriber routing to a task missing from the worker fails the deploy",
    async ({ prisma }) => {
      const { project, environment } = await seedProjectWithEnv(prisma);
      const worker = await seedWorkerWithTask(prisma, project, environment, "orders");

      await expect(
        syncDeclarativeWebhooks(
          {
            endpoints: [makeEndpointResource("payments")],
            subscribers: [
              taskSubscriber("payments", "orders"),
              taskSubscriber("payments", "refunds"),
            ],
          },
          worker,
          asEnv(environment),
          prisma,
          prisma
        )
      ).rejects.toThrow(
        /Webhook subscriber "refunds" on endpoint "payments" routes to unknown task "refunds"/
      );
    }
  );

  containerTest("a subscriber with an invalid filter fails the deploy", async ({ prisma }) => {
    const { project, environment } = await seedProjectWithEnv(prisma);
    const worker = await seedWorkerWithTask(prisma, project, environment, "orders");

    await expect(
      syncDeclarativeWebhooks(
        {
          endpoints: [makeEndpointResource("payments")],
          subscribers: [taskSubscriber("payments", "orders", "event.type ==")],
        },
        worker,
        asEnv(environment),
        prisma,
        prisma
      )
    ).rejects.toThrow(/Webhook subscriber "orders" on endpoint "payments" has an invalid filter/);
  });
});
