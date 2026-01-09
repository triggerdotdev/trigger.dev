#!/usr/bin/env tsx

import { program } from "commander";
import path from "path";
import fs from "fs/promises";
import { RunsReplicationHarness } from "../test/performance/harness";
import { getDefaultConfig, type HarnessConfig } from "../test/performance/config";

program
  .name("profile-runs-replication")
  .description("Profile RunsReplicationService performance and identify bottlenecks")
  .option("-c, --config <file>", "Config file path (JSON)")
  .option("-t, --throughput <number>", "Target throughput (records/sec)", "5000")
  .option("-d, --duration <number>", "Test duration per phase (seconds)", "60")
  .option("--mock-clickhouse", "Use mock ClickHouse (CPU-only profiling)")
  .option(
    "--profile <tool>",
    "Profiling tool: doctor, flame, both, none",
    "none"
  )
  .option("--output <dir>", "Output directory", "./profiling-results")
  .option("-v, --verbose", "Verbose logging")
  .parse();

async function loadConfig(options: any): Promise<HarnessConfig> {
  let config: HarnessConfig = getDefaultConfig() as HarnessConfig;

  // Load from config file if provided
  if (options.config) {
    console.log(`Loading config from: ${options.config}`);
    const configFile = await fs.readFile(options.config, "utf-8");
    const fileConfig = JSON.parse(configFile);
    config = { ...config, ...fileConfig };
  }

  // Override with CLI arguments
  if (options.throughput) {
    const throughput = parseInt(options.throughput, 10);
    config.producer.targetThroughput = throughput;

    // Update all phases if no config file was provided
    if (!options.config) {
      config.phases = config.phases.map((phase) => ({
        ...phase,
        targetThroughput: throughput,
      }));
    }
  }

  if (options.duration) {
    const duration = parseInt(options.duration, 10);

    // Update all phases if no config file was provided
    if (!options.config) {
      config.phases = config.phases.map((phase) => ({
        ...phase,
        durationSec: duration,
      }));
    }
  }

  if (options.mockClickhouse) {
    config.consumer.useMockClickhouse = true;
  }

  if (options.profile) {
    config.profiling.enabled = options.profile !== "none";
    config.profiling.tool = options.profile;
  }

  if (options.output) {
    config.profiling.outputDir = options.output;
  }

  if (options.verbose) {
    config.output.verbose = true;
  }

  // Ensure output directory exists
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0];
  const outputDir = path.join(config.profiling.outputDir, timestamp);
  config.profiling.outputDir = outputDir;
  config.output.metricsFile = path.join(outputDir, "metrics.json");

  return config;
}

function printConfig(config: HarnessConfig): void {
  console.log("\n" + "=".repeat(60));
  console.log("RunsReplicationService Performance Test Harness");
  console.log("=".repeat(60));
  console.log("\n📋 Configuration:");
  console.log(`  Profiling DB:       ${config.infrastructure.profilingDatabaseName}`);
  console.log(`  Output Dir:         ${config.profiling.outputDir}`);
  console.log(`  Mock ClickHouse:    ${config.consumer.useMockClickhouse ? "Yes (CPU-only)" : "No (full stack)"}`);
  console.log(`  Profiling Tool:     ${config.profiling.tool}`);
  console.log(`  Verbose:            ${config.output.verbose}`);

  console.log("\n📊 Test Phases:");
  for (const phase of config.phases) {
    console.log(`  - ${phase.name.padEnd(15)} ${phase.durationSec}s @ ${phase.targetThroughput} rec/sec`);
  }

  console.log("\n⚙️  Producer Config:");
  console.log(`  Insert/Update:      ${(config.producer.insertUpdateRatio * 100).toFixed(0)}% inserts`);
  console.log(`  Batch Size:         ${config.producer.batchSize}`);
  console.log(`  Payload Size:       ${config.producer.payloadSizeKB} KB`);

  console.log("\n⚙️  Consumer Config:");
  console.log(`  Flush Batch Size:   ${config.consumer.flushBatchSize}`);
  console.log(`  Flush Interval:     ${config.consumer.flushIntervalMs} ms`);
  console.log(`  Max Concurrency:    ${config.consumer.maxFlushConcurrency}`);

  console.log("\n" + "=".repeat(60) + "\n");
}

function printSummary(phases: any[]): void {
  console.log("\n" + "=".repeat(60));
  console.log("📈 Summary");
  console.log("=".repeat(60) + "\n");

  for (const phase of phases) {
    console.log(`${phase.phase}:`);
    console.log(`  Duration:              ${(phase.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Producer Throughput:   ${phase.producerThroughput.toFixed(1)} rec/sec`);
    console.log(`  Consumer Throughput:   ${phase.consumerThroughput.toFixed(1)} rec/sec`);
    console.log(`  Event Loop Util:       ${(phase.eventLoopUtilization * 100).toFixed(1)}%`);
    console.log(`  Heap Used:             ${phase.heapUsedMB.toFixed(1)} MB`);
    console.log(`  Replication Lag P95:   ${phase.replicationLagP95.toFixed(1)} ms`);
    console.log();
  }

  console.log("=".repeat(60) + "\n");
}

async function main() {
  const options = program.opts();
  const config = await loadConfig(options);

  printConfig(config);

  const harness = new RunsReplicationHarness(config);

  try {
    await harness.setup();
    const phases = await harness.run();
    await harness.teardown();

    // Export metrics
    await harness.exportMetrics(config.output.metricsFile);

    // Print summary
    printSummary(phases);

    console.log("\n✅ Profiling complete!");
    console.log(`📊 Results saved to: ${config.profiling.outputDir}\n`);

    if (config.profiling.enabled && config.profiling.tool !== "none") {
      console.log("🔥 Profiling data:");
      console.log(`   View flamegraph/analysis in: ${config.profiling.outputDir}\n`);
    }

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Profiling failed:");
    console.error(error);
    await harness.teardown().catch(() => {});
    process.exit(1);
  }
}

main();
