#!/usr/bin/env node
/**
 * Producer script that runs in a separate process to insert TaskRuns into PostgreSQL.
 * This simulates realistic production load for benchmarking RunsReplicationService.
 */

import { PrismaClient } from "@trigger.dev/database";
import { PrismaPg } from "@prisma/adapter-pg";
import { performance } from "node:perf_hooks";

interface ProducerConfig {
  postgresUrl: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  numRuns: number;
  errorRate: number; // 0.07 = 7%
  batchSize: number;
}

// Error templates for realistic variety
const ERROR_TEMPLATES = [
  {
    type: "TypeError",
    message: "Cannot read property 'foo' of undefined",
    stack: `TypeError: Cannot read property 'foo' of undefined
    at processData (/app/src/handler.ts:42:15)
    at runTask (/app/src/runtime.ts:128:20)
    at executeRun (/app/src/executor.ts:89:12)
    at async Runner.execute (/app/src/runner.ts:56:5)`,
  },
  {
    type: "Error",
    message: "Failed to fetch data from API endpoint https://api.example.com/data/12345",
    stack: `Error: Failed to fetch data from API endpoint https://api.example.com/data/12345
    at fetchData (/app/src/api.ts:78:11)
    at getData (/app/src/service.ts:34:18)
    at processTask (/app/src/handler.ts:23:15)
    at runTask (/app/src/runtime.ts:128:20)`,
  },
  {
    type: "ValidationError",
    message: "Invalid input: expected string for field 'email', got number: 1234567890",
    stack: `ValidationError: Invalid input: expected string for field 'email', got number: 1234567890
    at validateInput (/app/src/validator.ts:156:9)
    at processRequest (/app/src/handler.ts:67:23)
    at runTask (/app/src/runtime.ts:128:20)`,
  },
  {
    type: "TimeoutError",
    message: "Operation timed out after 30000ms",
    stack: `TimeoutError: Operation timed out after 30000ms
    at Timeout._onTimeout (/app/src/timeout.ts:45:15)
    at processTask (/app/src/handler.ts:89:12)
    at runTask (/app/src/runtime.ts:128:20)`,
  },
  {
    type: "DatabaseError",
    message: "Connection to database 'prod_db' failed: timeout of 5000ms exceeded",
    stack: `DatabaseError: Connection to database 'prod_db' failed: timeout of 5000ms exceeded
    at connect (/app/node_modules/pg/lib/client.js:234:11)
    at query (/app/src/db.ts:89:18)
    at getData (/app/src/service.ts:45:22)`,
  },
  {
    type: "ReferenceError",
    message: "userId is not defined",
    stack: `ReferenceError: userId is not defined
    at validateUser (/app/src/auth.ts:123:9)
    at processTask (/app/src/handler.ts:34:15)
    at runTask (/app/src/runtime.ts:128:20)`,
  },
];

function generateError() {
  const template = ERROR_TEMPLATES[Math.floor(Math.random() * ERROR_TEMPLATES.length)];

  // Add variation to make errors slightly different
  const randomId = Math.floor(Math.random() * 100000);
  const randomTimestamp = Date.now() + Math.floor(Math.random() * 10000);

  return {
    type: template.type,
    name: template.type,
    message: template.message
      .replace(/\d{4,}/g, String(randomId))
      .replace(/\d{13}/g, String(randomTimestamp)),
    stack: template.stack
      .replace(/:\d+:\d+/g, `:${Math.floor(Math.random() * 500)}:${Math.floor(Math.random() * 50)}`)
      .replace(/\d{4,}/g, String(randomId)),
  };
}

async function runProducer(config: ProducerConfig) {
  const adapter = new PrismaPg(config.postgresUrl);
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(
      `[Producer] Starting - will create ${config.numRuns} runs (${(config.errorRate * 100).toFixed(
        1
      )}% with errors)`
    );
    const startTime = performance.now();
    let created = 0;
    let withErrors = 0;

    // Process in batches to avoid overwhelming the database
    for (let batch = 0; batch < Math.ceil(config.numRuns / config.batchSize); batch++) {
      const batchStart = batch * config.batchSize;
      const batchEnd = Math.min(batchStart + config.batchSize, config.numRuns);
      const batchSize = batchEnd - batchStart;

      const runs = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const hasError = Math.random() < config.errorRate;
        const status = hasError ? "COMPLETED_WITH_ERRORS" : "COMPLETED_SUCCESSFULLY";

        const runData: any = {
          friendlyId: `run_bench_${Date.now()}_${i}`,
          taskIdentifier: `benchmark-task-${i % 10}`, // Vary task identifiers
          payload: JSON.stringify({ index: i, timestamp: Date.now() }),
          traceId: `trace_${i}`,
          spanId: `span_${i}`,
          queue: `queue-${i % 5}`, // Vary queues
          runtimeEnvironmentId: config.environmentId,
          projectId: config.projectId,
          organizationId: config.organizationId,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status,
          createdAt: new Date(Date.now() - Math.floor(Math.random() * 1000)),
          updatedAt: new Date(),
        };

        if (hasError) {
          runData.error = generateError();
          withErrors++;
        }

        runs.push(runData);
      }

      // Insert batch
      await prisma.taskRun.createMany({
        data: runs,
      });

      created += batchSize;

      if (batch % 10 === 0 || batch === Math.ceil(config.numRuns / config.batchSize) - 1) {
        const elapsed = performance.now() - startTime;
        const rate = (created / elapsed) * 1000;
        console.log(
          `[Producer] Progress: ${created}/${config.numRuns} runs (${rate.toFixed(0)} runs/sec)`
        );
      }
    }

    const endTime = performance.now();
    const duration = endTime - startTime;
    const throughput = (created / duration) * 1000;

    console.log(`[Producer] Completed:`);
    console.log(`  - Total runs: ${created}`);
    console.log(`  - With errors: ${withErrors} (${((withErrors / created) * 100).toFixed(1)}%)`);
    console.log(`  - Duration: ${duration.toFixed(0)}ms`);
    console.log(`  - Throughput: ${throughput.toFixed(0)} runs/sec`);

    // Send results to parent process
    if (process.send) {
      process.send({
        type: "complete",
        stats: {
          created,
          withErrors,
          duration,
          throughput,
        },
      });
    }
  } catch (error) {
    console.error("[Producer] Error:", error);
    if (process.send) {
      process.send({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse config from command line args
const configArg = process.argv[2];
if (!configArg) {
  console.error("Usage: runsReplicationBenchmark.producer.ts <config-json>");
  process.exit(1);
}

// This is ok for a benchmark script, but not for production code.
const config = JSON.parse(configArg) as ProducerConfig;
runProducer(config).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
