// End-to-end for the failure a configured-but-empty publication caused in production: the source
// replicated nothing, boot passed (a source WAS configured), and the only symptom was a log line
// every 30s. This drives the real service against a real publication with no tables and asserts the
// whole chain now produces a number: client -> onSourceError -> the /metrics counter.
import { ClickHouse } from "@internal/clickhouse";
import { PublicationMisconfiguredError } from "@internal/replication";
import { replicationContainerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { Registry, type RegistryContentType } from "prom-client";
import { buildRunsReplicationSourceMetrics } from "~/services/runsReplicationMetrics.server";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 90_000 });

describe("RunsReplicationService — a source whose publication carries no tables", () => {
  replicationContainerTest(
    "reports the source error, which lands on the alarmable counter",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      // The production shape: the publication exists, so the client adopts it rather than creating
      // one, and it carries no tables — so this source's WAL never reaches ClickHouse.
      await prisma.$executeRawUnsafe(`CREATE PUBLICATION empty_pub;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        logLevel: "warn",
      });

      const register = new Registry<RegistryContentType>();
      const metrics = buildRunsReplicationSourceMetrics(register);
      const reported: Array<{ sourceId: string; error: unknown }> = [];

      const service = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication",
        slotName: "empty_pub_slot",
        publicationName: "empty_pub",
        redisOptions,
        flushIntervalMs: 100,
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        logLevel: "error",
        sources: [
          {
            id: "shard-a",
            pgConnectionUrl: postgresContainer.getConnectionUri(),
            slotName: "empty_pub_slot",
            publicationName: "empty_pub",
            originGeneration: 2,
          },
        ],
        onSourceError: (info) => {
          reported.push(info);
          metrics.recordSourceError(info);
        },
      });

      try {
        await service.start();

        const deadline = Date.now() + 20_000;
        while (
          !reported.some((r) => r.error instanceof PublicationMisconfiguredError) &&
          Date.now() < deadline
        ) {
          await setTimeout(250);
        }
      } finally {
        await service.shutdown();
      }

      const misconfigured = reported.filter(
        (r) => r.error instanceof PublicationMisconfiguredError
      );
      expect(misconfigured.length).toBeGreaterThan(0);
      expect(misconfigured[0]?.sourceId).toBe("shard-a");

      expect(await register.metrics()).toContain(
        'runs_replication_publication_misconfigured_total{source="shard-a"}'
      );
    }
  );
});
