import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryMetrics } from "./utils/tracing";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 90_000 });

// Copied from runsReplicationService.part4.test.ts (the only replication part-test that
// injects a meter). These read metric data points out of the in-memory reader.
function makeMetricReaders(
  metrics: Awaited<ReturnType<ReturnType<typeof createInMemoryMetrics>["getMetrics"]>>
) {
  function getMetricData(name: string) {
    for (const resourceMetrics of metrics) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name === name) {
            return metric;
          }
        }
      }
    }
    return null;
  }

  function histogramHasData(metric: any): boolean {
    if (!metric?.dataPoints || metric.dataPoints.length === 0) return false;
    return metric.dataPoints.some((dp: any) => {
      return (
        (typeof dp.count === "number" && dp.count > 0) ||
        (typeof dp.value?.count === "number" && dp.value.count > 0) ||
        (Array.isArray(dp.buckets?.counts) && dp.buckets.counts.some((c: number) => c > 0)) ||
        (typeof dp.sum === "number" && dp.sum > 0) ||
        typeof dp.min === "number" ||
        typeof dp.max === "number"
      );
    });
  }

  function getCounterAttributeValues(metric: any, attributeName: string): unknown[] {
    if (!metric?.dataPoints) return [];
    return metric.dataPoints
      .filter((dp: any) => dp.attributes?.[attributeName] !== undefined)
      .map((dp: any) => dp.attributes[attributeName]);
  }

  return { getMetricData, histogramHasData, getCounterAttributeValues };
}

// Poll the in-memory reader until the lag histogram has data (replication is async, and
// container/CPU contention makes a fixed sleep flaky). Returns the latest collected metrics.
async function waitForLagHistogram(
  metricsHelper: ReturnType<typeof createInMemoryMetrics>,
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs;
  let metrics = await metricsHelper.getMetrics();
  while (Date.now() < deadline) {
    const { getMetricData, histogramHasData } = makeMetricReaders(metrics);
    if (histogramHasData(getMetricData("runs_replication.replication_lag_ms"))) {
      return metrics;
    }
    await setTimeout(250);
    metrics = await metricsHelper.getMetrics();
  }
  return metrics;
}

async function seedRun(client: PrismaClient, tag: string) {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const org = await client.organization.create({
    data: { title: `org-${tag}-${suffix}`, slug: `org-${tag}-${suffix}` },
  });
  const project = await client.project.create({
    data: {
      name: `proj-${tag}-${suffix}`,
      slug: `proj-${tag}-${suffix}`,
      organizationId: org.id,
      externalRef: `proj-${tag}-${suffix}`,
    },
  });
  const env = await client.runtimeEnvironment.create({
    data: {
      slug: `env-${tag}-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: org.id,
      apiKey: `apikey-${tag}-${suffix}`,
      pkApiKey: `pkapikey-${tag}-${suffix}`,
      shortcode: `shortcode-${tag}-${suffix}`,
    },
  });
  await client.taskRun.create({
    data: {
      friendlyId: `run_${tag}_${suffix}`,
      taskIdentifier: `my-task-${tag}`,
      payload: JSON.stringify({ foo: "bar" }),
      payloadType: "application/json",
      traceId: `trace-${tag}-${suffix}`,
      spanId: `span-${tag}-${suffix}`,
      queue: `test-${tag}`,
      runtimeEnvironmentId: env.id,
      projectId: project.id,
      organizationId: org.id,
      environmentType: "DEVELOPMENT",
      engine: "V2",
      status: "PENDING",
    },
  });
}

describe("RunsReplicationService (part 9/9) - per-source replication-lag attribute", () => {
  // Two named sources fanning into one flush scheduler (the production dual-fan-in shape).
  // Both point at the warm fixture Postgres via independent slots/publications, so the test
  // proves the per-source `.record(lag, { source, generation })` attribute deterministically
  // for two distinct producer identities. The cross-version (PG14<->PG17) replication boundary
  // itself is covered by part8's dual-source dedup test; here we assert the lag *attribution*,
  // which is identical regardless of the producer's Postgres version.
  replicationContainerTest(
    "tags the replication-lag histogram with each source id for a dual-source service",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const pgUrl = postgresContainer.getConnectionUri();

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-lag-per-source",
        logLevel: "warn",
      });

      const metricsHelper = createInMemoryMetrics();
      let runsReplicationService: RunsReplicationService | undefined;

      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

        runsReplicationService = new RunsReplicationService({
          clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
          serviceName: "runs-replication-lag-per-source",
          redisOptions,
          sources: [
            {
              id: "legacy",
              pgConnectionUrl: pgUrl,
              slotName: "tr_lag_legacy_v1",
              publicationName: "tr_lag_legacy_v1_pub",
              originGeneration: 0,
            },
            {
              id: "new",
              pgConnectionUrl: pgUrl,
              slotName: "tr_lag_new_v1",
              publicationName: "tr_lag_new_v1_pub",
              originGeneration: 1,
            },
          ],
          maxFlushConcurrency: 1,
          flushIntervalMs: 100,
          flushBatchSize: 1,
          leaderLockTimeoutMs: 5000,
          leaderLockExtendIntervalMs: 1000,
          ackIntervalSeconds: 5,
          meter: metricsHelper.meter,
          logLevel: "warn",
        });

        await runsReplicationService.start();

        // Each insert is decoded by BOTH slots (both subscribe to the same table), so a single
        // seed produces a lag point tagged "legacy" and one tagged "new". Poll until both land.
        const deadline = Date.now() + 40_000;
        let sources: unknown[] = [];
        let metrics = await metricsHelper.getMetrics();
        while (Date.now() < deadline) {
          const { getMetricData, getCounterAttributeValues } = makeMetricReaders(metrics);
          sources = getCounterAttributeValues(
            getMetricData("runs_replication.replication_lag_ms"),
            "source"
          );
          if (sources.includes("legacy") && sources.includes("new")) break;
          await seedRun(prisma, "lag");
          await setTimeout(500);
          metrics = await metricsHelper.getMetrics();
        }

        const { getMetricData, histogramHasData } = makeMetricReaders(metrics);
        const replicationLag = getMetricData("runs_replication.replication_lag_ms");
        expect(replicationLag).not.toBeNull();
        expect(histogramHasData(replicationLag)).toBe(true);

        // Each source's id appears as a label value on at least one lag data point.
        expect(sources).toContain("legacy");
        expect(sources).toContain("new");
      } finally {
        await runsReplicationService?.stop();
        await metricsHelper.shutdown();
      }
    }
  );

  // Single-source passthrough. When a single source is used, the lag
  // histogram records exactly one `source` label value (the source's id).
  replicationContainerTest(
    "records a single source label in single-source mode",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-lag-single-source",
        logLevel: "warn",
      });

      const metricsHelper = createInMemoryMetrics();

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        serviceName: "runs-replication-lag-single-source",
        redisOptions,
        sources: [
          {
            id: "default",
            pgConnectionUrl: postgresContainer.getConnectionUri(),
            slotName: "tr_lag_single_v1",
            publicationName: "tr_lag_single_v1_pub",
            originGeneration: 0,
          },
        ],
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        meter: metricsHelper.meter,
        logLevel: "warn",
      });

      try {
        await runsReplicationService.start();

        await seedRun(prisma, "single");

        const metrics = await waitForLagHistogram(metricsHelper);
        const { getMetricData, histogramHasData, getCounterAttributeValues } =
          makeMetricReaders(metrics);

        const replicationLag = getMetricData("runs_replication.replication_lag_ms");
        expect(replicationLag).not.toBeNull();
        expect(histogramHasData(replicationLag)).toBe(true);

        const sources = getCounterAttributeValues(replicationLag, "source");
        const uniqueSources = [...new Set(sources)];
        expect(uniqueSources).toEqual(["default"]);
      } finally {
        await runsReplicationService.stop();
        await metricsHelper.shutdown();
      }
    }
  );
});
