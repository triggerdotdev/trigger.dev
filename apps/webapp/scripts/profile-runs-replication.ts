#!/usr/bin/env tsx

import { program } from "commander";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { RunsReplicationHarness } from "../test/performance/harness";
import { getDefaultConfig, type HarnessConfig } from "../test/performance/config";

program
  .name("profile-runs-replication")
  .description("Profile RunsReplicationService performance and identify bottlenecks")
  .option("-c, --config <file>", "Config file path (JSON)")
  .option("-n, --name <name>", "Run name/label (e.g., 'baseline', 'optimized-v1')")
  .option("--description <text>", "Run description (what is being tested)")
  .option("-t, --throughput <number>", "Target throughput (records/sec)", "5000")
  .option("-d, --duration <number>", "Test duration per phase (seconds)", "60")
  .option("-w, --workers <number>", "Number of producer worker processes", "1")
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
    const fileConfig = JSON.parse(configFile) as Partial<HarnessConfig>;
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

  if (options.workers) {
    config.producer.workerCount = parseInt(options.workers, 10);
  }

  if (options.name) {
    config.runName = options.name;
  }

  if (options.description) {
    config.runDescription = options.description;
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

  // Organize output directory: profiling-results/[runName]-[timestamp]/
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").split("_")[0];
  const timeWithSeconds = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").substring(0, 19);
  const runFolder = `${config.runName}-${timeWithSeconds}`;
  const outputDir = path.join(config.profiling.outputDir, runFolder);

  config.profiling.outputDir = outputDir;
  config.output.metricsFile = path.join(outputDir, "metrics.json");

  return config;
}

function printConfig(config: HarnessConfig): void {
  console.log("\n" + "=".repeat(60));
  console.log("RunsReplicationService Performance Test Harness");
  console.log("=".repeat(60));
  console.log(`\n🏷️  Run: ${config.runName}`);
  if (config.runDescription) {
    console.log(`📝 Description: ${config.runDescription}`);
  }
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
  console.log(`  Worker Processes:   ${config.producer.workerCount}`);
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

async function createSummaryReport(
  config: HarnessConfig,
  phases: any[],
  outputPath: string
): Promise<void> {
  const lines: string[] = [];

  // Header
  lines.push(`# Performance Test Run: ${config.runName}`);
  lines.push("");
  lines.push(`**Date**: ${new Date().toISOString()}`);
  if (config.runDescription) {
    lines.push(`**Description**: ${config.runDescription}`);
  }
  lines.push("");

  // Configuration
  lines.push("## Configuration");
  lines.push("");
  lines.push(`- **Producer Workers**: ${config.producer.workerCount}`);
  lines.push(`- **Batch Size**: ${config.producer.batchSize}`);
  lines.push(`- **Insert/Update Ratio**: ${(config.producer.insertUpdateRatio * 100).toFixed(0)}% inserts`);
  lines.push(`- **Payload Size**: ${config.producer.payloadSizeKB} KB`);
  lines.push(`- **Consumer Flush Batch**: ${config.consumer.flushBatchSize}`);
  lines.push(`- **Consumer Flush Interval**: ${config.consumer.flushIntervalMs} ms`);
  lines.push(`- **Consumer Max Concurrency**: ${config.consumer.maxFlushConcurrency}`);
  lines.push(`- **ClickHouse Mode**: ${config.consumer.useMockClickhouse ? "Mock (CPU-only)" : "Real"}`);
  lines.push(`- **Profiling Tool**: ${config.profiling.tool}`);
  lines.push("");

  // Key Results - highlight most important metrics
  lines.push("## Key Results");
  lines.push("");

  // For flamegraph runs, focus on throughput only
  if (config.profiling.enabled && config.profiling.tool !== "none") {
    lines.push("**Profiling Output**: See flamegraph/analysis files in this directory");
    lines.push("");
    lines.push("### Throughput");
    lines.push("");
    lines.push("| Phase | Duration | Producer (rec/sec) | Consumer (rec/sec) |");
    lines.push("|-------|----------|--------------------|--------------------|");
    for (const phase of phases) {
      lines.push(
        `| ${phase.phase} | ${(phase.durationMs / 1000).toFixed(1)}s | ${phase.producerThroughput.toFixed(0)} | ${phase.consumerThroughput.toFixed(0)} |`
      );
    }
  } else {
    // For non-profiling runs, show ELU prominently
    lines.push("### Throughput & Event Loop Utilization");
    lines.push("");
    lines.push("| Phase | Duration | Producer (rec/sec) | Consumer (rec/sec) | ELU (%) |");
    lines.push("|-------|----------|--------------------|--------------------|---------|");
    for (const phase of phases) {
      lines.push(
        `| ${phase.phase} | ${(phase.durationMs / 1000).toFixed(1)}s | ${phase.producerThroughput.toFixed(0)} | ${phase.consumerThroughput.toFixed(0)} | ${(phase.eventLoopUtilization * 100).toFixed(1)}% |`
      );
    }
  }
  lines.push("");

  // Detailed Metrics
  lines.push("## Detailed Metrics");
  lines.push("");

  for (const phase of phases) {
    lines.push(`### ${phase.phase}`);
    lines.push("");
    lines.push(`- **Duration**: ${(phase.durationMs / 1000).toFixed(1)}s`);
    lines.push(`- **Records Produced**: ${phase.recordsProduced.toLocaleString()}`);
    lines.push(`- **Records Consumed**: ${phase.recordsConsumed.toLocaleString()}`);
    lines.push(`- **Batches Flushed**: ${phase.batchesFlushed.toLocaleString()}`);
    lines.push(`- **Producer Throughput**: ${phase.producerThroughput.toFixed(1)} rec/sec`);
    lines.push(`- **Consumer Throughput**: ${phase.consumerThroughput.toFixed(1)} rec/sec`);
    lines.push(`- **Event Loop Utilization**: ${(phase.eventLoopUtilization * 100).toFixed(1)}%`);
    lines.push(`- **Heap Used**: ${phase.heapUsedMB.toFixed(1)} MB`);
    lines.push(`- **Heap Total**: ${phase.heapTotalMB.toFixed(1)} MB`);
    lines.push(`- **Replication Lag P50**: ${phase.replicationLagP50.toFixed(1)} ms`);
    lines.push(`- **Replication Lag P95**: ${phase.replicationLagP95.toFixed(1)} ms`);
    lines.push(`- **Replication Lag P99**: ${phase.replicationLagP99.toFixed(1)} ms`);
    lines.push("");
  }

  // Write to file
  await fs.writeFile(outputPath, lines.join("\n"));
}

async function generateVisualization(config: HarnessConfig): Promise<void> {
  console.log("\n🔥 Generating flamegraph visualization...");

  // Find the clinic flame data file
  const files = await fs.readdir(config.profiling.outputDir);
  const flameDataFile = files.find((f) => f.endsWith(".clinic-flame"));

  if (!flameDataFile) {
    console.warn("⚠️  No clinic flame data file found. Skipping visualization.");
    return;
  }

  const dataPath = path.join(config.profiling.outputDir, flameDataFile);
  console.log(`   Data file: ${flameDataFile}`);

  // Run clinic flame --visualize-only
  const clinicPath = path.join(__dirname, "../node_modules/.bin/clinic");

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(clinicPath, ["flame", "--visualize-only", dataPath], {
      stdio: "inherit",
      cwd: path.join(__dirname, ".."),
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        console.log("✅ Flamegraph generated successfully!");
        console.log(`   Open: ${dataPath.replace(".clinic-flame", ".clinic-flame.html")}\n`);
        resolve();
      } else {
        console.error(`⚠️  Flamegraph generation exited with code ${code}`);
        resolve(); // Don't fail the whole run
      }
    });

    proc.on("error", (error) => {
      console.error("⚠️  Error generating flamegraph:", error.message);
      resolve(); // Don't fail the whole run
    });
  });
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

    // Export metrics JSON
    await harness.exportMetrics(config.output.metricsFile);

    // Create summary report
    const summaryPath = path.join(config.profiling.outputDir, "SUMMARY.md");
    await createSummaryReport(config, phases, summaryPath);

    // Print summary
    printSummary(phases);

    console.log("\n✅ Profiling complete!");
    console.log(`📊 Results saved to: ${config.profiling.outputDir}`);
    console.log(`📄 Summary report: ${summaryPath}`);
    console.log(`📊 Detailed metrics: ${config.output.metricsFile}\n`);

    if (config.profiling.enabled && config.profiling.tool !== "none") {
      // Generate visualization from collected data
      await generateVisualization(config);
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
