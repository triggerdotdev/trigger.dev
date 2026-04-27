import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { fork, type ChildProcess } from "node:child_process";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing, createInMemoryMetrics } from "./utils/tracing";

// Extend test timeout for benchmarks
vi.setConfig({ testTimeout: 300_000 }); // 5 minutes

/**
 * Benchmark configuration
 */
const BENCHMARK_CONFIG = {
  // Number of runs to create - adjust this to test different volumes
  // Start with smaller numbers (1000) for quick tests, increase to 10000+ for realistic benchmarks
  NUM_RUNS: parseInt(process.env.BENCHMARK_NUM_RUNS || "5000", 10),

  // Error rate (7% = realistic production load with some failures)
  ERROR_RATE: 0.07,

  // Batch size for producer
  PRODUCER_BATCH_SIZE: 100,

  // Replication service settings
  FLUSH_BATCH_SIZE: 50,
  FLUSH_INTERVAL_MS: 100,
  MAX_FLUSH_CONCURRENCY: 4,

  // How long to wait for replication to complete (in ms)
  REPLICATION_TIMEOUT_MS: 120_000, // 2 minutes
};

interface BenchmarkResult {
  name: string;
  fingerprintingEnabled: boolean;
  producerStats: {
    created: number;
    withErrors: number;
    duration: number;
    throughput: number;
  };
  replicationStats: {
    duration: number;
    throughput: number;
    replicatedRuns: number;
  };
  eluStats: {
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    samples: number[];
  };
  metricsStats: {
    batchesFlushed: number;
    taskRunsInserted: number;
    payloadsInserted: number;
    eventsProcessed: number;
  };
}

/**
 * Measure Event Loop Utilization during benchmark
 */
class ELUMonitor {
  private samples: number[] = [];
  private interval: NodeJS.Timeout | null = null;
  private startELU: { idle: number; active: number } | null = null;

  start(intervalMs: number = 100) {
    this.samples = [];
    this.startELU = performance.eventLoopUtilization();

    this.interval = setInterval(() => {
      const elu = performance.eventLoopUtilization();
      const utilization = elu.utilization * 100; // Convert to percentage
      this.samples.push(utilization);
    }, intervalMs);
  }

  stop(): { mean: number; p50: number; p95: number; p99: number; samples: number[] } {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.samples.length === 0) {
      return { mean: 0, p50: 0, p95: 0, p99: 0, samples: [] };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, val) => sum + val, 0) / sorted.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return { mean, p50, p95, p99, samples: sorted };
  }
}

/**
 * Run the producer script in a separate process
 */
async function runProducer(config: {
  postgresUrl: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  numRuns: number;
  errorRate: number;
  batchSize: number;
}): Promise<{ created: number; withErrors: number; duration: number; throughput: number }> {
  return new Promise((resolve, reject) => {
    const producerPath = path.join(__dirname, "runsReplicationBenchmark.producer.ts");

    // Use tsx to run the TypeScript file directly
    const child = fork(producerPath, [JSON.stringify(config)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: ["-r", "tsx/cjs"],
    });

    let output = "";

    child.stdout?.on("data", (data) => {
      const text = data.toString();
      output += text;
      console.log(text.trim());
    });

    child.stderr?.on("data", (data) => {
      console.error(data.toString().trim());
    });

    child.on("message", (message: any) => {
      if (message.type === "complete") {
        resolve(message.stats);
      } else if (message.type === "error") {
        reject(new Error(message.error));
      }
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Producer exited with code ${code}`));
      }
    });
  });
}

/**
 * Wait for all runs to be replicated to ClickHouse
 */
async function waitForReplication(
  clickhouse: ClickHouse,
  organizationId: string,
  expectedCount: number,
  timeoutMs: number
): Promise<{ duration: number; replicatedRuns: number }> {
  const startTime = performance.now();
  const deadline = startTime + timeoutMs;

  const queryRuns = clickhouse.reader.query({
    name: "benchmark-count",
    query:
      "SELECT count(*) as count FROM trigger_dev.task_runs_v2 WHERE organization_id = {org_id:String}",
    schema: z.object({ count: z.number() }),
    params: z.object({ org_id: z.string() }),
  });

  while (performance.now() < deadline) {
    const [error, result] = await queryRuns({ org_id: organizationId });

    if (error) {
      throw new Error(`Failed to query ClickHouse: ${error.message}`);
    }

    const count = result?.[0]?.count || 0;

    if (count >= expectedCount) {
      const duration = performance.now() - startTime;
      return { duration, replicatedRuns: count };
    }

    // Wait a bit before checking again
    await setTimeout(500);
  }

  throw new Error(
    `Replication timeout: expected ${expectedCount} runs, but only found ${await getRunCount(
      clickhouse
    )} after ${timeoutMs}ms`
  );
}

async function getRunCount(clickhouse: ClickHouse): Promise<number> {
  const queryRuns = clickhouse.reader.query({
    name: "benchmark-count",
    query: "SELECT count(*) as count FROM trigger_dev.task_runs_v2",
    schema: z.object({ count: z.number() }),
  });

  const [error, result] = await queryRuns({});
  if (error) return 0;
  return result?.[0]?.count || 0;
}

/**
 * Extract metrics from OpenTelemetry metrics
 */
function extractMetrics(metrics: any[]): {
  batchesFlushed: number;
  taskRunsInserted: number;
  payloadsInserted: number;
  eventsProcessed: number;
} {
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

  function sumCounterValues(metric: any): number {
    if (!metric?.dataPoints) return 0;
    return metric.dataPoints.reduce((sum: number, dp: any) => sum + (dp.value || 0), 0);
  }

  return {
    batchesFlushed: sumCounterValues(getMetricData("runs_replication.batches_flushed")),
    taskRunsInserted: sumCounterValues(getMetricData("runs_replication.task_runs_inserted")),
    payloadsInserted: sumCounterValues(getMetricData("runs_replication.payloads_inserted")),
    eventsProcessed: sumCounterValues(getMetricData("runs_replication.events_processed")),
  };
}

/**
 * Run a single benchmark test
 */
async function runBenchmark(
  name: string,
  fingerprintingEnabled: boolean,
  {
    clickhouseContainer,
    redisOptions,
    postgresContainer,
    prisma,
  }: {
    clickhouseContainer: any;
    redisOptions: any;
    postgresContainer: any;
    prisma: any;
  }
): Promise<BenchmarkResult> {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`BENCHMARK: ${name}`);
  console.log(`Error Fingerprinting: ${fingerprintingEnabled ? "ENABLED" : "DISABLED"}`);
  console.log(
    `Runs: ${BENCHMARK_CONFIG.NUM_RUNS}, Error Rate: ${(BENCHMARK_CONFIG.ERROR_RATE * 100).toFixed(
      1
    )}%`
  );
  console.log(`${"=".repeat(80)}\n`);

  // Setup
  const organization = await prisma.organization.create({
    data: {
      title: `benchmark-${name}`,
      slug: `benchmark-${name}`,
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `benchmark-${name}`,
      slug: `benchmark-${name}`,
      organizationId: organization.id,
      externalRef: `benchmark-${name}`,
    },
  });

  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `benchmark-${name}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `benchmark-${name}`,
      pkApiKey: `benchmark-${name}`,
      shortcode: `benchmark-${name}`,
    },
  });

  // Setup ClickHouse
  const clickhouse = new ClickHouse({
    url: clickhouseContainer.getConnectionUrl(),
    name: `benchmark-${name}`,
    compression: {
      request: true,
    },
    logLevel: "warn",
  });

  // Setup tracing and metrics
  const { tracer } = createInMemoryTracing();
  const metricsHelper = createInMemoryMetrics();

  // Create and start replication service
  const runsReplicationService = new RunsReplicationService({
    clickhouse,
    pgConnectionUrl: postgresContainer.getConnectionUri(),
    serviceName: `benchmark-${name}`,
    slotName: `benchmark_${name.replace(/-/g, "_")}`,
    publicationName: `benchmark_${name.replace(/-/g, "_")}_pub`,
    redisOptions,
    maxFlushConcurrency: BENCHMARK_CONFIG.MAX_FLUSH_CONCURRENCY,
    flushIntervalMs: BENCHMARK_CONFIG.FLUSH_INTERVAL_MS,
    flushBatchSize: BENCHMARK_CONFIG.FLUSH_BATCH_SIZE,
    leaderLockTimeoutMs: 10000,
    leaderLockExtendIntervalMs: 2000,
    ackIntervalSeconds: 10,
    tracer,
    meter: metricsHelper.meter,
    logLevel: "warn",
    disableErrorFingerprinting: !fingerprintingEnabled,
  });

  await runsReplicationService.start();

  // Start ELU monitoring
  const eluMonitor = new ELUMonitor();
  eluMonitor.start(100);

  let producerStats!: BenchmarkResult["producerStats"];
  let replicationResult!: { duration: number; replicatedRuns: number };
  let metricsStats!: BenchmarkResult["metricsStats"];
  let eluStats!: BenchmarkResult["eluStats"];

  try {
    // Run producer in separate process
    console.log("\n[Benchmark] Starting producer...");
    producerStats = await runProducer({
      postgresUrl: postgresContainer.getConnectionUri(),
      organizationId: organization.id,
      projectId: project.id,
      environmentId: runtimeEnvironment.id,
      numRuns: BENCHMARK_CONFIG.NUM_RUNS,
      errorRate: BENCHMARK_CONFIG.ERROR_RATE,
      batchSize: BENCHMARK_CONFIG.PRODUCER_BATCH_SIZE,
    });

    console.log("\n[Benchmark] Waiting for replication to complete...");
    replicationResult = await waitForReplication(
      clickhouse,
      organization.id,
      producerStats.created,
      BENCHMARK_CONFIG.REPLICATION_TIMEOUT_MS
    );

    const metrics = await metricsHelper.getMetrics();
    metricsStats = extractMetrics(metrics);
  } finally {
    eluStats = eluMonitor.stop();
    await runsReplicationService.stop();
    await metricsHelper.shutdown();
  }

  const throughput = (replicationResult.replicatedRuns / replicationResult.duration) * 1000;

  const result: BenchmarkResult = {
    name,
    fingerprintingEnabled,
    producerStats,
    replicationStats: {
      duration: replicationResult.duration,
      throughput,
      replicatedRuns: replicationResult.replicatedRuns,
    },
    eluStats,
    metricsStats,
  };

  // Print results
  console.log(`\n${"=".repeat(80)}`);
  console.log(`RESULTS: ${name}`);
  console.log(`${"=".repeat(80)}`);
  console.log("\nProducer:");
  console.log(`  Created: ${producerStats.created} runs`);
  console.log(
    `  With errors: ${producerStats.withErrors} (${(
      (producerStats.withErrors / producerStats.created) *
      100
    ).toFixed(1)}%)`
  );
  console.log(`  Duration: ${producerStats.duration.toFixed(0)}ms`);
  console.log(`  Throughput: ${producerStats.throughput.toFixed(0)} runs/sec`);
  console.log("\nReplication:");
  console.log(`  Replicated: ${replicationResult.replicatedRuns} runs`);
  console.log(`  Duration: ${replicationResult.duration.toFixed(0)}ms`);
  console.log(`  Throughput: ${throughput.toFixed(0)} runs/sec`);
  console.log("\nEvent Loop Utilization:");
  console.log(`  Mean: ${eluStats.mean.toFixed(2)}%`);
  console.log(`  P50: ${eluStats.p50.toFixed(2)}%`);
  console.log(`  P95: ${eluStats.p95.toFixed(2)}%`);
  console.log(`  P99: ${eluStats.p99.toFixed(2)}%`);
  console.log(`  Samples: ${eluStats.samples.length}`);
  console.log("\nMetrics:");
  console.log(`  Batches flushed: ${metricsStats.batchesFlushed}`);
  console.log(`  Task runs inserted: ${metricsStats.taskRunsInserted}`);
  console.log(`  Payloads inserted: ${metricsStats.payloadsInserted}`);
  console.log(`  Events processed: ${metricsStats.eventsProcessed}`);
  console.log(`${"=".repeat(80)}\n`);

  return result;
}

/**
 * Compare two benchmark results and print delta
 */
function compareBenchmarks(baseline: BenchmarkResult, comparison: BenchmarkResult) {
  console.log(`\n${"=".repeat(80)}`);
  console.log("COMPARISON");
  console.log(
    `Baseline: ${baseline.name} (fingerprinting ${baseline.fingerprintingEnabled ? "ON" : "OFF"})`
  );
  console.log(
    `Comparison: ${comparison.name} (fingerprinting ${
      comparison.fingerprintingEnabled ? "ON" : "OFF"
    })`
  );
  console.log(`${"=".repeat(80)}`);

  const replicationDurationDelta =
    ((comparison.replicationStats.duration - baseline.replicationStats.duration) /
      baseline.replicationStats.duration) *
    100;
  const throughputDelta =
    ((comparison.replicationStats.throughput - baseline.replicationStats.throughput) /
      baseline.replicationStats.throughput) *
    100;
  const eluMeanDelta =
    ((comparison.eluStats.mean - baseline.eluStats.mean) / baseline.eluStats.mean) * 100;
  const eluP99Delta =
    ((comparison.eluStats.p99 - baseline.eluStats.p99) / baseline.eluStats.p99) * 100;

  console.log("\nReplication Duration:");
  console.log(
    `  ${baseline.replicationStats.duration.toFixed(
      0
    )}ms → ${comparison.replicationStats.duration.toFixed(0)}ms (${
      replicationDurationDelta > 0 ? "+" : ""
    }${replicationDurationDelta.toFixed(2)}%)`
  );

  console.log("\nThroughput:");
  console.log(
    `  ${baseline.replicationStats.throughput.toFixed(
      0
    )} → ${comparison.replicationStats.throughput.toFixed(0)} runs/sec (${
      throughputDelta > 0 ? "+" : ""
    }${throughputDelta.toFixed(2)}%)`
  );

  console.log("\nEvent Loop Utilization (Mean):");
  console.log(
    `  ${baseline.eluStats.mean.toFixed(2)}% → ${comparison.eluStats.mean.toFixed(2)}% (${
      eluMeanDelta > 0 ? "+" : ""
    }${eluMeanDelta.toFixed(2)}%)`
  );

  console.log("\nEvent Loop Utilization (P99):");
  console.log(
    `  ${baseline.eluStats.p99.toFixed(2)}% → ${comparison.eluStats.p99.toFixed(2)}% (${
      eluP99Delta > 0 ? "+" : ""
    }${eluP99Delta.toFixed(2)}%)`
  );

  console.log(`\n${"=".repeat(80)}\n`);

  // Return deltas for assertions if needed
  return {
    replicationDurationDelta,
    throughputDelta,
    eluMeanDelta,
    eluP99Delta,
  };
}

describe("RunsReplicationService Benchmark", () => {
  containerTest.skipIf(process.env.BENCHMARKS_ENABLED !== "1")(
    "should benchmark error fingerprinting performance impact",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      // Enable replica identity for TaskRun table
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      console.log("\n" + "=".repeat(80));
      console.log("RUNS REPLICATION SERVICE - ERROR FINGERPRINTING BENCHMARK");
      console.log("=".repeat(80));
      console.log(`Configuration:`);
      console.log(`  Total runs: ${BENCHMARK_CONFIG.NUM_RUNS}`);
      console.log(`  Error rate: ${(BENCHMARK_CONFIG.ERROR_RATE * 100).toFixed(1)}%`);
      console.log(
        `  Expected errors: ~${Math.floor(BENCHMARK_CONFIG.NUM_RUNS * BENCHMARK_CONFIG.ERROR_RATE)}`
      );
      console.log(`  Producer batch size: ${BENCHMARK_CONFIG.PRODUCER_BATCH_SIZE}`);
      console.log(`  Replication batch size: ${BENCHMARK_CONFIG.FLUSH_BATCH_SIZE}`);
      console.log(`  Max flush concurrency: ${BENCHMARK_CONFIG.MAX_FLUSH_CONCURRENCY}`);
      console.log("=".repeat(80) + "\n");

      // Run benchmark WITHOUT error fingerprinting (baseline)
      const baselineResult = await runBenchmark("baseline-no-fingerprinting", false, {
        clickhouseContainer,
        redisOptions,
        postgresContainer,
        prisma,
      });

      // Run benchmark WITH error fingerprinting
      const fingerprintingResult = await runBenchmark("with-fingerprinting", true, {
        clickhouseContainer,
        redisOptions,
        postgresContainer,
        prisma,
      });

      // Compare results
      const deltas = compareBenchmarks(baselineResult, fingerprintingResult);

      // Basic assertions - just to ensure benchmarks completed successfully
      expect(baselineResult.replicationStats.replicatedRuns).toBe(BENCHMARK_CONFIG.NUM_RUNS);
      expect(fingerprintingResult.replicationStats.replicatedRuns).toBe(BENCHMARK_CONFIG.NUM_RUNS);

      // Log final summary
      console.log("BENCHMARK COMPLETE");
      console.log(
        `Fingerprinting impact on replication duration: ${
          deltas.replicationDurationDelta > 0 ? "+" : ""
        }${deltas.replicationDurationDelta.toFixed(2)}%`
      );
      console.log(
        `Fingerprinting impact on throughput: ${
          deltas.throughputDelta > 0 ? "+" : ""
        }${deltas.throughputDelta.toFixed(2)}%`
      );
      console.log(
        `Fingerprinting impact on ELU (mean): ${
          deltas.eluMeanDelta > 0 ? "+" : ""
        }${deltas.eluMeanDelta.toFixed(2)}%`
      );
      console.log(
        `Fingerprinting impact on ELU (P99): ${
          deltas.eluP99Delta > 0 ? "+" : ""
        }${deltas.eluP99Delta.toFixed(2)}%`
      );
    }
  );
});
