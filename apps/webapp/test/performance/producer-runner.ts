#!/usr/bin/env tsx

import { PrismaClient } from "@trigger.dev/database";
import { TaskRunDataGenerator } from "./data-generator";
import { TaskRunProducer } from "./producer";
import type { ProducerConfig } from "./config";

async function main() {
  if (!process.send) {
    throw new Error("This script must be run as a child process with IPC enabled");
  }

  // Parse configuration from environment variable
  const config: ProducerConfig = JSON.parse(process.env.PRODUCER_CONFIG!);

  console.log("Producer process starting with config:", {
    targetThroughput: config.targetThroughput,
    batchSize: config.batchSize,
    insertUpdateRatio: config.insertUpdateRatio,
  });

  // Connect to PostgreSQL
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: config.databaseUrl,
      },
    },
  });

  // Create data generator
  const dataGenerator = new TaskRunDataGenerator({
    organizationId: config.organizationId,
    projectId: config.projectId,
    runtimeEnvironmentId: config.runtimeEnvironmentId,
    environmentType: config.environmentType,
    payloadSizeKB: config.payloadSizeKB,
    includeComplexPayloads: false, // Disabled to avoid BigInt serialization issues
  });

  // Create producer
  const producer = new TaskRunProducer({
    prisma,
    dataGenerator,
    workerId: config.workerId,
    targetThroughput: config.targetThroughput,
    insertUpdateRatio: config.insertUpdateRatio,
    batchSize: config.batchSize,
  });

  // Send metrics to parent every second
  const metricsInterval = setInterval(() => {
    const metrics = producer.getMetrics();
    process.send!({
      type: "metrics",
      data: metrics,
    });
  }, 1000);

  // Listen for commands from parent process
  process.on("message", async (msg: any) => {
    try {
      if (msg.type === "start") {
        console.log("Producer: Starting production at", msg.throughput || config.targetThroughput, "records/sec");
        await producer.start();
        process.send!({ type: "started" });
      } else if (msg.type === "stop") {
        console.log("Producer: Stopping production");
        await producer.stop();
        process.send!({ type: "stopped" });
        // Don't exit - wait for restart or shutdown command
      } else if (msg.type === "shutdown") {
        console.log("Producer: Shutting down");
        await producer.stop();
        clearInterval(metricsInterval);
        await prisma.$disconnect();
        process.send!({ type: "shutdown_complete" });
        process.exit(0);
      }
    } catch (error) {
      console.error("Producer process error:", error);
      process.send!({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle uncaught errors (log but don't exit - producer loop handles errors gracefully)
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception in producer:", error);
    process.send!({
      type: "error",
      error: error.message,
    });
    // Don't exit - let the producer loop continue
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection in producer:", reason);
    process.send!({
      type: "error",
      error: String(reason),
    });
    // Don't exit - let the producer loop continue
  });

  // Signal ready to parent
  console.log("Producer process ready");
  process.send!({ type: "ready" });
}

main().catch((error) => {
  console.error("Fatal error in producer process:", error);
  process.exit(1);
});
