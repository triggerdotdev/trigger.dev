#!/usr/bin/env tsx

import type { ClickHouse } from "@internal/clickhouse";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { MockClickHouse, asMockClickHouse } from "./clickhouse-mock";
import type { ConsumerConfig } from "./config";
import fs from "fs";
import path from "path";

async function main() {
  const hasIPC = !!process.send;

  if (!hasIPC) {
    console.log(
      "Warning: IPC not available (likely running under profiler) - metrics will not be sent to parent"
    );
  }

  // Parse configuration from environment variable
  const config = JSON.parse(process.env.CONSUMER_CONFIG!) as ConsumerConfig;

  // Create shutdown signal file path
  const shutdownFilePath = path.join(config.outputDir || "/tmp", ".shutdown-signal");

  console.log("Consumer process starting with config:", {
    useMockClickhouse: config.useMockClickhouse,
    flushBatchSize: config.flushBatchSize,
    flushIntervalMs: config.flushIntervalMs,
    maxFlushConcurrency: config.maxFlushConcurrency,
  });

  // Create ClickHouse client (real or mocked)
  let clickhouse: Pick<ClickHouse, "taskRuns">;
  if (config.useMockClickhouse) {
    clickhouse = asMockClickHouse(new MockClickHouse(config.mockClickhouseDelay));
  } else {
    // Use dynamic import to avoid module resolution issues with tsx
    const { ClickHouse } = await import("@internal/clickhouse");
    clickhouse = new ClickHouse({
      url: config.clickhouseUrl!,
      name: "runs-replication-profiling",
      compression: {
        request: true,
      },
      logLevel: "info",
    });
  }

  // Create replication service
  const service = new RunsReplicationService({
    clickhouse: clickhouse as ClickHouse,
    pgConnectionUrl: config.pgConnectionUrl,
    serviceName: "runs-replication-profiling",
    slotName: config.slotName,
    publicationName: config.publicationName,
    redisOptions: config.redisOptions,
    flushBatchSize: config.flushBatchSize,
    flushIntervalMs: config.flushIntervalMs,
    maxFlushConcurrency: config.maxFlushConcurrency,
    logLevel: "error", // Only log errors to reduce CPU overhead
  });

  console.log("Consumer: Starting RunsReplicationService");
  await service.start();

  // Send batch flush events to parent via IPC (if available)
  if (hasIPC) {
    service.events.on("batchFlushed", (data) => {
      process.send!({
        type: "batchFlushed",
        data,
      });
    });
  }

  // Watch for shutdown signal file (works even when IPC is unavailable)
  const shutdownCheckInterval = setInterval(() => {
    if (fs.existsSync(shutdownFilePath)) {
      console.log("Consumer: Shutdown signal file detected, exiting...");
      clearInterval(shutdownCheckInterval);
      clearInterval(metricsInterval);
      // Clean up the signal file
      try {
        fs.unlinkSync(shutdownFilePath);
      } catch (e) {}
      process.exit(0);
    }
  }, 500);

  // Send periodic metrics to parent (if IPC available)
  const metricsInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    const { eventLoopUtilization } = require("perf_hooks").performance;
    const elu = eventLoopUtilization ? eventLoopUtilization() : { utilization: 0 };

    if (hasIPC) {
      process.send!({
        type: "metrics",
        data: {
          heapUsed: memUsage.heapUsed,
          heapTotal: memUsage.heapTotal,
          rss: memUsage.rss,
          eventLoopUtilization: elu.utilization,
        },
      });
    }
  }, 1000);

  // Listen for shutdown signal from parent (if IPC available, for non-profiling mode)
  if (hasIPC) {
    process.on("message", async (msg: any) => {
      if (msg.type === "shutdown") {
        console.log("Consumer: Received IPC shutdown message");
        clearInterval(shutdownCheckInterval);
        clearInterval(metricsInterval);
        process.exit(0);
      }
    });
  }

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception in consumer:", error);
    if (hasIPC) {
      process.send!({
        type: "error",
        error: error.message,
      });
    }
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection in consumer:", reason);
    if (hasIPC) {
      process.send!({
        type: "error",
        error: String(reason),
      });
    }
    process.exit(1);
  });

  // Signal ready to parent (if IPC available)
  console.log("Consumer process ready");
  if (hasIPC) {
    process.send!({ type: "ready" });
  } else {
    // When profiling without IPC, just run indefinitely
    console.log("Running in profiling mode - press Ctrl+C to stop");
  }
}

main().catch((error) => {
  console.error("Fatal error in consumer process:", error);
  process.exit(1);
});
