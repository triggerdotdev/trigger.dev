import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { fork } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";
import { createInMemoryMetrics, createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 300_000 });

const CONFIG = {
  NUM_RUNS: parseInt(process.env.BENCHMARK_NUM_RUNS || "5000", 10),
  PRODUCER_BATCH_SIZE: 100,
  FLUSH_BATCH_SIZE: 50,
  FLUSH_INTERVAL_MS: 100,
  MAX_FLUSH_CONCURRENCY: 4,
  REPLICATION_TIMEOUT_MS: 180_000,
  POISON_RATE: parseFloat(process.env.BENCHMARK_POISON_RATE || "0.05"),
};

class ELUMonitor {
  private samples: number[] = [];
  private interval: NodeJS.Timeout | null = null;

  start(intervalMs = 100) {
    this.samples = [];
    let last = performance.eventLoopUtilization();
    this.interval = setInterval(() => {
      const current = performance.eventLoopUtilization();
      this.samples.push(performance.eventLoopUtilization(current, last).utilization * 100);
      last = current;
    }, intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.samples.length === 0) return { mean: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    return {
      mean,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      samples: sorted.length,
    };
  }
}

function runProducer(config: {
  postgresUrl: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  numRuns: number;
  errorRate: number;
  batchSize: number;
  poisonRate: number;
  poisonDepth: number;
}): Promise<{ created: number; withErrors: number; poisoned: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const producerPath = path.join(__dirname, "runsReplicationBenchmark.producer.ts");
    const child = fork(producerPath, [JSON.stringify(config)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["-r", "tsx/cjs"],
    });
    child.stdout?.on("data", (d) => console.log(d.toString().trim()));
    child.stderr?.on("data", (d) => console.error(d.toString().trim()));
    child.on("message", (m: any) => {
      if (m.type === "complete") resolve(m.stats);
      else if (m.type === "error") reject(new Error(m.error));
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Producer exited with code ${code}`));
    });
  });
}

async function waitForCount(
  clickhouse: ClickHouse,
  organizationId: string,
  expectedCount: number,
  timeoutMs: number
): Promise<{ duration: number; count: number }> {
  const startTime = performance.now();
  const deadline = startTime + timeoutMs;
  const queryRuns = clickhouse.reader.query({
    name: "bench-count",
    query:
      "SELECT count(*) as count FROM trigger_dev.task_runs_v2 WHERE organization_id = {org_id:String}",
    schema: z.object({ count: z.number() }),
    params: z.object({ org_id: z.string() }),
  });
  while (performance.now() < deadline) {
    const [error, result] = await queryRuns({ org_id: organizationId });
    if (error) throw new Error(`Failed to query ClickHouse: ${error.message}`);
    const count = result?.[0]?.count || 0;
    if (count >= expectedCount) return { duration: performance.now() - startTime, count };
    await setTimeout(500);
  }
  const [, result] = await queryRuns({ org_id: organizationId });
  return { duration: performance.now() - startTime, count: result?.[0]?.count || 0 };
}

async function runScenario(
  name: string,
  poisonRate: number,
  ctx: { clickhouseContainer: any; redisOptions: any; postgresContainer: any; prisma: any }
) {
  const { clickhouseContainer, redisOptions, postgresContainer, prisma } = ctx;

  const organization = await prisma.organization.create({
    data: { title: `bench-${name}`, slug: `bench-${name}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `bench-${name}`,
      slug: `bench-${name}`,
      organizationId: organization.id,
      externalRef: `bench-${name}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `bench-${name}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `bench-${name}`,
      pkApiKey: `bench-${name}`,
      shortcode: `bench-${name}`,
    },
  });

  const clickhouse = new ClickHouse({
    url: clickhouseContainer.getConnectionUrl(),
    name: `bench-${name}`,
    compression: { request: true },
    logLevel: "error",
  });

  const { tracer } = createInMemoryTracing();
  const metricsHelper = createInMemoryMetrics();

  const service = new RunsReplicationService({
    clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
    pgConnectionUrl: postgresContainer.getConnectionUri(),
    serviceName: `bench-${name}`,
    slotName: `bench_${name.replace(/-/g, "_")}`,
    publicationName: `bench_${name.replace(/-/g, "_")}_pub`,
    redisOptions,
    maxFlushConcurrency: CONFIG.MAX_FLUSH_CONCURRENCY,
    flushIntervalMs: CONFIG.FLUSH_INTERVAL_MS,
    flushBatchSize: CONFIG.FLUSH_BATCH_SIZE,
    maxPoisonStripsPerBatch: CONFIG.NUM_RUNS,
    leaderLockTimeoutMs: 10000,
    leaderLockExtendIntervalMs: 2000,
    ackIntervalSeconds: 10,
    tracer,
    meter: metricsHelper.meter,
    logLevel: "error",
  });

  await service.start();

  const elu = new ELUMonitor();
  elu.start(100);

  let producerStats!: { created: number; withErrors: number; poisoned: number; duration: number };
  let replication!: { duration: number; count: number };
  let eluStats!: ReturnType<ELUMonitor["stop"]>;

  try {
    producerStats = await runProducer({
      postgresUrl: postgresContainer.getConnectionUri(),
      organizationId: organization.id,
      projectId: project.id,
      environmentId: runtimeEnvironment.id,
      numRuns: CONFIG.NUM_RUNS,
      errorRate: 0.07,
      batchSize: CONFIG.PRODUCER_BATCH_SIZE,
      poisonRate,
      poisonDepth: 1500,
    });

    const expectedLanded = producerStats.created;
    replication = await waitForCount(
      clickhouse,
      organization.id,
      expectedLanded,
      CONFIG.REPLICATION_TIMEOUT_MS
    );
  } finally {
    eluStats = elu.stop();
    await service.stop();
    await metricsHelper.shutdown();
  }

  const throughput = (replication.count / replication.duration) * 1000;
  const expectedLanded = producerStats.created;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`SCENARIO: ${name}  (poison rate ${(poisonRate * 100).toFixed(1)}%)`);
  console.log(`${"=".repeat(72)}`);
  console.log(`Produced:     ${producerStats.created} runs (${producerStats.poisoned} poisoned)`);
  console.log(`Landed in CH: ${replication.count} / expected ${expectedLanded}`);
  console.log(`Repl dur:     ${replication.duration.toFixed(0)}ms`);
  console.log(`Throughput:   ${throughput.toFixed(0)} runs/sec`);
  console.log(`Row-isolation recoveries: ${service.rowIsolationRecoveries}`);
  console.log(`Recovery cap hits: ${service.recoveryCapHits}`);
  console.log(`Rows stripped (kept row, lost JSON): ${service.rowsStripped}`);
  console.log(`Rows dropped (unrecoverable): ${service.permanentlyDroppedRows}`);
  console.log(`Dropped batches (whole): ${service.permanentlyDroppedBatches}`);
  console.log(
    `ELU mean=${eluStats.mean.toFixed(2)}% p50=${eluStats.p50.toFixed(2)}% p95=${eluStats.p95.toFixed(2)}% p99=${eluStats.p99.toFixed(2)}% (${eluStats.samples} samples)`
  );
  console.log(`${"=".repeat(72)}\n`);

  return {
    name,
    poisonRate,
    producerStats,
    replication,
    eluStats,
    throughput,
    expectedLanded,
    service,
  };
}

describe("RunsReplicationService JSON-recovery ELU benchmark", () => {
  replicationContainerTest.skipIf(process.env.BENCHMARKS_ENABLED !== "1")(
    "measures ELU on the healthy hot path vs the row-isolation recovery path",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const healthy = await runScenario("healthy-0pct", 0, {
        clickhouseContainer,
        redisOptions,
        postgresContainer,
        prisma,
      });

      const poisoned = await runScenario("poison", CONFIG.POISON_RATE, {
        clickhouseContainer,
        redisOptions,
        postgresContainer,
        prisma,
      });

      const eluMeanDelta =
        ((poisoned.eluStats.mean - healthy.eluStats.mean) / healthy.eluStats.mean) * 100;
      const eluP99Delta =
        ((poisoned.eluStats.p99 - healthy.eluStats.p99) / healthy.eluStats.p99) * 100;

      console.log(`\n${"=".repeat(72)}`);
      console.log("COMPARISON  (healthy 0% -> poison)");
      console.log(`${"=".repeat(72)}`);
      console.log(
        `ELU mean: ${healthy.eluStats.mean.toFixed(2)}% -> ${poisoned.eluStats.mean.toFixed(2)}% (${eluMeanDelta > 0 ? "+" : ""}${eluMeanDelta.toFixed(1)}%)`
      );
      console.log(
        `ELU p99:  ${healthy.eluStats.p99.toFixed(2)}% -> ${poisoned.eluStats.p99.toFixed(2)}% (${eluP99Delta > 0 ? "+" : ""}${eluP99Delta.toFixed(1)}%)`
      );
      console.log(`${"=".repeat(72)}\n`);

      expect(healthy.replication.count).toBe(healthy.expectedLanded);
      expect(healthy.service.rowIsolationRecoveries).toBe(0);
      expect(healthy.service.rowsStripped).toBe(0);
      expect(healthy.service.permanentlyDroppedBatches).toBe(0);

      expect(poisoned.replication.count).toBe(poisoned.expectedLanded);
      expect(poisoned.service.permanentlyDroppedBatches).toBe(0);
      expect(poisoned.service.permanentlyDroppedRows).toBe(0);
      expect(poisoned.service.recoveryCapHits).toBe(0);
      expect(poisoned.service.rowIsolationRecoveries).toBeGreaterThanOrEqual(1);
      expect(poisoned.service.rowsStripped).toBe(poisoned.producerStats.poisoned);
    }
  );
});
