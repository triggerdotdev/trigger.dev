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
  // Container-free replacement for the previous dual-source variant, which polled the live
  // lag histogram against real containers until both source labels appeared (timing- and
  // label-order-flaky). It was really proving the per-source `.record(lag, { source })`
  // attribution and that the metric read/merge helpers surface every source label — asserted
  // here by recording known lag points and reading them back through those same helpers.
  test("merges recorded lag exports and surfaces every source label", async () => {
    const metricsHelper = createInMemoryMetrics();

    try {
      const lagHistogram = metricsHelper.meter.createHistogram(
        "runs_replication.replication_lag_ms",
        {
          description: "Replication lag from Postgres commit to processing",
          unit: "ms",
        }
      );

      // An unrelated metric so the readers must walk past non-matching entries in the tree.
      const batchesFlushed = metricsHelper.meter.createCounter("runs_replication.batches_flushed");
      batchesFlushed.add(1, { source: "legacy" });

      // Two producer identities fan into the same histogram; distinct attribute sets produce
      // distinct data points, one per source.
      lagHistogram.record(12, { source: "legacy", generation: 0 });
      lagHistogram.record(34, { source: "new", generation: 1 });

      const metrics = await metricsHelper.getMetrics();
      const { getMetricData, histogramHasData, getCounterAttributeValues } =
        makeMetricReaders(metrics);

      const replicationLag = getMetricData("runs_replication.replication_lag_ms");
      expect(replicationLag).not.toBeNull();

      // A name that isn't present must read back as null (the readers walk the whole tree).
      expect(getMetricData("runs_replication.does_not_exist")).toBeNull();

      expect(histogramHasData(replicationLag)).toBe(true);

      // Every source id appears as a label value across the merged lag data points.
      const sources = getCounterAttributeValues(replicationLag, "source");
      expect(sources).toContain("legacy");
      expect(sources).toContain("new");

      const uniqueSources = [...new Set(sources)].sort();
      expect(uniqueSources).toEqual(["legacy", "new"]);
    } finally {
      await metricsHelper.shutdown();
    }
  });

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
