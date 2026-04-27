import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { SessionsReplicationService } from "~/services/sessionsReplicationService.server";

vi.setConfig({ testTimeout: 60_000 });

describe("SessionsReplicationService", () => {
  containerTest(
    "replicates an insert from Postgres Session → ClickHouse sessions_v1",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      // Logical replication needs full-row images for DELETE events.
      await prisma.$executeRawUnsafe(`ALTER TABLE public."Session" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "sessions-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const service = new SessionsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "sessions-replication",
        slotName: "sessions_to_clickhouse_v1",
        publicationName: "sessions_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      await service.start();

      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const environment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      const session = await prisma.session.create({
        data: {
          id: "session_test_insert_1",
          friendlyId: "session_abc123",
          externalId: "my-test-session",
          type: "chat.agent",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          taskIdentifier: "my-agent",
          triggerConfig: {
            basePayload: { messages: [], trigger: "preload" },
          },
          tags: ["user:42", "plan:pro"],
          metadata: { plan: "pro", seats: 3 },
        },
      });

      // Allow the replication pipeline to flush
      await setTimeout(2000);

      const querySessions = clickhouse.reader.query({
        name: "read-sessions",
        query: "SELECT * FROM trigger_dev.sessions_v1 FINAL",
        schema: z.any(),
      });

      const [queryError, result] = await querySessions({});

      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(
        expect.objectContaining({
          session_id: session.id,
          friendly_id: session.friendlyId,
          external_id: "my-test-session",
          type: "chat.agent",
          project_id: project.id,
          environment_id: environment.id,
          organization_id: organization.id,
          environment_type: "DEVELOPMENT",
          task_identifier: "my-agent",
          tags: ["user:42", "plan:pro"],
          _is_deleted: 0,
        })
      );

      await service.stop();
    }
  );

  containerTest(
    "replicates an update (close) from Postgres → ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."Session" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "sessions-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const service = new SessionsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "sessions-replication",
        slotName: "sessions_to_clickhouse_v1",
        publicationName: "sessions_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      await service.start();

      const organization = await prisma.organization.create({
        data: { title: "test", slug: "test" },
      });
      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      const created = await prisma.session.create({
        data: {
          id: "session_test_update_1",
          friendlyId: "session_update1",
          type: "chat.agent",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: organization.id,
          taskIdentifier: "my-agent",
          triggerConfig: {
            basePayload: { messages: [], trigger: "preload" },
          },
        },
      });

      await setTimeout(1000);

      await prisma.session.update({
        where: { id: created.id },
        data: { closedAt: new Date(), closedReason: "test-close" },
      });

      await setTimeout(2000);

      const querySessions = clickhouse.reader.query({
        name: "read-sessions-closed",
        query: "SELECT closed_reason, closed_at FROM trigger_dev.sessions_v1 FINAL",
        schema: z.any(),
      });

      const [queryError, result] = await querySessions({});

      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0].closed_reason).toBe("test-close");
      expect(result?.[0].closed_at).toBeDefined();

      await service.stop();
    }
  );
});
