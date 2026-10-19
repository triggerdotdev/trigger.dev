import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { WebhookDeliveriesReplicationService } from "~/services/webhookDeliveriesReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 60_000 });

const PUBLICATION = "webhook_deliveries_to_clickhouse_v1_publication";

function buildService(clickhouse: ClickHouse, pgUrl: string, redisOptions: object) {
  return new WebhookDeliveriesReplicationService({
    clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
    pgConnectionUrl: pgUrl,
    serviceName: "webhook-deliveries-replication",
    slotName: "webhook_deliveries_to_clickhouse_v1",
    publicationName: PUBLICATION,
    redisOptions: redisOptions as never,
    maxFlushConcurrency: 1,
    flushIntervalMs: 100,
    flushBatchSize: 10,
    leaderLockTimeoutMs: 5000,
    leaderLockExtendIntervalMs: 1000,
    ackIntervalSeconds: 5,
    logLevel: "warn",
  });
}

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({ data: { title: "wh", slug: "wh" } });
  const project = await prisma.project.create({
    data: { name: "wh", slug: "wh", organizationId: organization.id, externalRef: "wh" },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_wh",
      pkApiKey: "pk_dev_wh",
      shortcode: "wh",
    },
  });
  return { organization, project, environment };
}

async function createEndpoint(
  prisma: PrismaClient,
  scope: Awaited<ReturnType<typeof seedEnvironment>>
) {
  return prisma.webhookEndpoint.create({
    data: {
      friendlyId: "wh_replicated_1",
      opaqueId: "op_replicated_1",
      organizationId: scope.organization.id,
      projectId: scope.project.id,
      runtimeEnvironmentId: scope.environment.id,
      environmentType: "DEVELOPMENT",
      source: "stripe",
      declaredId: "payments",
      routingTargets: [
        {
          type: "task",
          id: "orders",
          taskId: "orders",
          filter: "event.type == 'checkout.session.completed'",
          filterAst: { kind: "cmp", path: "event.type", op: "eq", value: "x" },
        },
        {
          type: "session",
          id: "agent-x:events",
          taskIdentifier: "agent-x",
          keyTemplate: "{body.customer}",
          deliverAs: "action",
        },
      ],
      verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
      status: "ACTIVE",
    },
  });
}

/** Endpoint rows in ClickHouse, polled until `until` holds (replication flushes asynchronously). */
async function readEndpoints(
  clickhouse: ClickHouse,
  until: (rows: Array<Record<string, any>>) => boolean = (rows) => rows.length > 0
) {
  const query = clickhouse.reader.query({
    name: "read-webhook-endpoints",
    query:
      "SELECT endpoint_id, declared_id, status, has_signing_secret, manually_deactivated, subscriber_ids, subscribers FROM trigger_dev.webhook_endpoints_v1 FINAL",
    schema: z.any(),
  });
  let rows: Array<Record<string, any>> = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const [error, result] = await query({});
    expect(error).toBeNull();
    rows = result ?? [];
    if (until(rows)) break;
    await setTimeout(200);
  }
  return rows;
}

describe("WebhookDeliveriesReplicationService", () => {
  replicationContainerTest(
    "replicates webhook endpoints alongside deliveries, keeping only subscriber fields",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "webhook-deliveries-replication",
        logLevel: "warn",
      });
      const service = buildService(clickhouse, postgresContainer.getConnectionUri(), redisOptions);
      await service.start();

      try {
        const scope = await seedEnvironment(prisma);
        const endpoint = await createEndpoint(prisma, scope);
        await prisma.webhookDelivery.create({
          data: {
            id: "delivery_replicated_1",
            friendlyId: "whd_delivery_replicated_1",
            webhookEndpointId: endpoint.id,
            organizationId: scope.organization.id,
            projectId: scope.project.id,
            runtimeEnvironmentId: scope.environment.id,
            environmentType: "DEVELOPMENT",
            externalDeliveryId: "evt_1",
            idempotencyKey: "evt_1",
            status: "SUCCEEDED",
          },
        });

        const [row] = await readEndpoints(clickhouse);
        expect(row).toMatchObject({
          endpoint_id: endpoint.id,
          declared_id: "payments",
          status: "ACTIVE",
          has_signing_secret: 0,
          manually_deactivated: 0,
          subscriber_ids: ["orders", "agent-x:events"],
        });
        expect(JSON.parse(row.subscribers)).toEqual([
          {
            id: "orders",
            type: "task",
            taskId: "orders",
            filter: "event.type == 'checkout.session.completed'",
          },
          { id: "agent-x:events", type: "session", taskId: "agent-x", deliverAs: "action" },
        ]);

        const deliveries = clickhouse.reader.query({
          name: "read-webhook-deliveries",
          query: "SELECT delivery_id, status FROM trigger_dev.webhook_deliveries_v2 FINAL",
          schema: z.any(),
        });
        let deliveryRows: unknown[] = [];
        for (let attempt = 0; attempt < 50 && deliveryRows.length === 0; attempt++) {
          const [deliveryError, result] = await deliveries({});
          expect(deliveryError).toBeNull();
          deliveryRows = result ?? [];
          if (deliveryRows.length === 0) await setTimeout(200);
        }
        expect(deliveryRows).toEqual([
          { delivery_id: "delivery_replicated_1", status: "SUCCEEDED" },
        ]);

        await prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { status: "INACTIVE", manuallyDeactivatedAt: new Date(), signingSecretKey: "key" },
        });
        const [updated] = await readEndpoints(clickhouse, (rows) => rows[0]?.status === "INACTIVE");
        expect(updated).toMatchObject({
          status: "INACTIVE",
          manually_deactivated: 1,
          has_signing_secret: 1,
        });
      } finally {
        await service.stop();
      }
    }
  );

  replicationContainerTest(
    "adds the endpoint table to a publication created before it was replicated",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(
        `CREATE PUBLICATION "${PUBLICATION}" FOR TABLE "WebhookDelivery" WITH (publish = 'insert, update, delete');`
      );

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "webhook-deliveries-replication",
        logLevel: "warn",
      });
      const service = buildService(clickhouse, postgresContainer.getConnectionUri(), redisOptions);
      await service.start();

      try {
        const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
          `SELECT tablename FROM pg_publication_tables WHERE pubname = '${PUBLICATION}' ORDER BY tablename`
        );
        expect(tables.map((table) => table.tablename)).toEqual([
          "WebhookDelivery",
          "WebhookEndpoint",
        ]);

        const scope = await seedEnvironment(prisma);
        const endpoint = await createEndpoint(prisma, scope);

        const rows = await readEndpoints(clickhouse);
        expect(rows.map((row: { endpoint_id: string }) => row.endpoint_id)).toEqual([endpoint.id]);
      } finally {
        await service.stop();
      }
    }
  );
});
