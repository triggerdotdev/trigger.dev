#!/usr/bin/env tsx

/**
 * Recovery script for runs stuck in currentConcurrency with QUEUED execution status
 *
 * PROBLEM:
 * During high database load, runs can get dequeued from Redis (added to currentConcurrency)
 * but fail to update their execution status in the database. This leaves them stuck in an
 * inconsistent state where they won't be re-dequeued because they're marked as "in progress"
 * in Redis, but their database state still shows QUEUED.
 *
 * SOLUTION:
 * This script identifies and recovers these stuck runs by:
 * 1. Reading from the environment currentConcurrency Redis set
 * 2. Checking which runs have QUEUED execution status (inconsistent state)
 * 3. Re-adding them to their specific queue sorted sets
 * 4. Removing them from the queue-specific currentConcurrency sets
 * 5. Removing them from the environment-level currentConcurrency set
 *
 * SAFETY:
 * - Dry-run mode when no write Redis URL is provided (read-only, no writes)
 * - Uses separate Redis connections for reads and writes
 * - Write connection only created when redisWriteUrl is provided
 *
 * ARGUMENTS:
 *   <environmentId>   The Trigger.dev environment ID (e.g., env_abc123)
 *   <postgresUrl>     PostgreSQL connection string
 *   <redisReadUrl>    Redis connection string for reads (redis:// or rediss://)
 *   [redisWriteUrl]   Optional Redis connection string for writes (omit for dry-run)
 *
 * USAGE:
 *   tsx scripts/recover-stuck-runs.ts <environmentId> <postgresUrl> <redisReadUrl> [redisWriteUrl]
 *
 * EXAMPLES:
 *
 *   Dry-run mode (safe, no writes):
 *   tsx scripts/recover-stuck-runs.ts env_1234567890 \
 *     "postgresql://user:pass@localhost:5432/triggerdev" \
 *     "redis://readonly.example.com:6379"
 *
 *   Execute mode (makes actual changes):
 *   tsx scripts/recover-stuck-runs.ts env_1234567890 \
 *     "postgresql://user:pass@localhost:5432/triggerdev" \
 *     "redis://readonly.example.com:6379" \
 *     "redis://writeonly.example.com:6379"
 */

import { PrismaClient, TaskRunExecutionStatus } from "@trigger.dev/database";
import { createRedisClient } from "@internal/redis";

interface StuckRun {
  runId: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  queue: string;
  concurrencyKey: string | null;
  executionStatus: TaskRunExecutionStatus;
  snapshotCreatedAt: Date;
  taskIdentifier: string;
}

interface RedisOperation {
  type: "ZADD" | "SREM";
  key: string;
  args: (string | number)[];
  description: string;
}

async function main() {
  const [environmentId, postgresUrl, redisReadUrl, redisWriteUrl] = process.argv.slice(2);

  if (!environmentId || !postgresUrl || !redisReadUrl) {
    console.error("Usage: tsx scripts/recover-stuck-runs.ts <environmentId> <postgresUrl> <redisReadUrl> [redisWriteUrl]");
    console.error("");
    console.error("Dry-run mode when no redisWriteUrl is provided (read-only).");
    console.error("Execute mode when redisWriteUrl is provided (makes actual changes).");
    console.error("");
    console.error("Example (dry-run):");
    console.error('  tsx scripts/recover-stuck-runs.ts env_1234567890 \\');
    console.error('    "postgresql://user:pass@localhost:5432/triggerdev" \\');
    console.error('    "redis://readonly.example.com:6379"');
    console.error("");
    console.error("Example (execute):");
    console.error('  tsx scripts/recover-stuck-runs.ts env_1234567890 \\');
    console.error('    "postgresql://user:pass@localhost:5432/triggerdev" \\');
    console.error('    "redis://readonly.example.com:6379" \\');
    console.error('    "redis://writeonly.example.com:6379"');
    process.exit(1);
  }

  const executeMode = !!redisWriteUrl;

  if (executeMode) {
    console.log("⚠️  EXECUTE MODE - Changes will be made to Redis\n");
  } else {
    console.log("🔍 DRY RUN MODE - No changes will be made to Redis\n");
  }

  console.log(`🔍 Scanning for stuck runs in environment: ${environmentId}`);

  // Create Prisma client with the provided connection URL
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: postgresUrl,
      },
    },
  });

  try {
    // Get environment details
    const environment = await prisma.runtimeEnvironment.findUnique({
      where: { id: environmentId },
      include: {
        organization: true,
        project: true,
      },
    });

    if (!environment) {
      console.error(`❌ Environment not found: ${environmentId}`);
      process.exit(1);
    }

    console.log(`📍 Environment: ${environment.slug} (${environment.type})`);
    console.log(`📍 Organization: ${environment.organization.slug}`);
    console.log(`📍 Project: ${environment.project.slug}`);

    // Parse Redis read URL
    const redisReadUrlObj = new URL(redisReadUrl);
    const redisReadOptions = {
      host: redisReadUrlObj.hostname,
      port: parseInt(redisReadUrlObj.port || "6379"),
      username: redisReadUrlObj.username || undefined,
      password: redisReadUrlObj.password || undefined,
      enableAutoPipelining: false,
      ...(redisReadUrlObj.protocol === "rediss:"
        ? {
            tls: {
              // If connecting via localhost tunnel to a remote Redis, disable cert verification
              rejectUnauthorized: redisReadUrlObj.hostname === "localhost" ? false : true,
            },
          }
        : {}),
    };

    // Create Redis read client
    const redisRead = createRedisClient(redisReadOptions);

    // Create Redis write client if redisWriteUrl is provided
    let redisWrite = null;
    if (redisWriteUrl) {
      const redisWriteUrlObj = new URL(redisWriteUrl);
      const redisWriteOptions = {
        host: redisWriteUrlObj.hostname,
        port: parseInt(redisWriteUrlObj.port || "6379"),
        username: redisWriteUrlObj.username || undefined,
        password: redisWriteUrlObj.password || undefined,
        enableAutoPipelining: false,
        ...(redisWriteUrlObj.protocol === "rediss:"
          ? {
              tls: {
                // If connecting via localhost tunnel to a remote Redis, disable cert verification
                rejectUnauthorized: redisWriteUrlObj.hostname === "localhost" ? false : true,
              },
            }
          : {}),
      };
      redisWrite = createRedisClient(redisWriteOptions);
    }

    try {
      // Build the Redis key for environment-level currentConcurrency set
      // Format: engine:runqueue:{org:X}:proj:Y:env:Z:currentConcurrency
      const envConcurrencyKey = `engine:runqueue:{org:${environment.organizationId}}:proj:${environment.projectId}:env:${environmentId}:currentConcurrency`;

      console.log(`\n🔑 Checking Redis key: ${envConcurrencyKey}`);

      // Get all run IDs in the environment's currentConcurrency set
      const runIds = await redisRead.smembers(envConcurrencyKey);

      if (runIds.length === 0) {
        console.log(`✅ No runs in currentConcurrency set`);
        return;
      }

      console.log(`📊 Found ${runIds.length} runs in currentConcurrency set`);

      // Query database for latest snapshots and queue info of these runs
      const runInfo = await prisma.$queryRaw<
        Array<{
          runId: string;
          executionStatus: TaskRunExecutionStatus;
          snapshotCreatedAt: Date;
          organizationId: string;
          projectId: string;
          environmentId: string;
          taskIdentifier: string;
          queue: string;
          concurrencyKey: string | null;
        }>
      >`
        SELECT DISTINCT ON (s."runId")
          s."runId",
          s."executionStatus",
          s."createdAt" as "snapshotCreatedAt",
          r."organizationId",
          r."projectId",
          r."runtimeEnvironmentId" as "environmentId",
          r."taskIdentifier",
          r."queue",
          r."concurrencyKey"
        FROM "TaskRunExecutionSnapshot" s
        INNER JOIN "TaskRun" r ON r.id = s."runId"
        WHERE s."runId" = ANY(${runIds})
          AND s."isValid" = true
        ORDER BY s."runId", s."createdAt" DESC
      `;

      const stuckRuns: StuckRun[] = [];

      // Find runs with QUEUED execution status (inconsistent state)
      for (const info of runInfo) {
        if (info.executionStatus === "QUEUED") {
          stuckRuns.push({
            runId: info.runId,
            orgId: info.organizationId,
            projectId: info.projectId,
            environmentId: info.environmentId,
            queue: info.queue,
            concurrencyKey: info.concurrencyKey,
            executionStatus: info.executionStatus,
            snapshotCreatedAt: info.snapshotCreatedAt,
            taskIdentifier: info.taskIdentifier,
          });
        }
      }

      if (stuckRuns.length === 0) {
        console.log(`✅ No stuck runs found (all runs have progressed beyond QUEUED state)`);
        return;
      }

      console.log(`\n⚠️  Found ${stuckRuns.length} stuck runs in QUEUED state:`);
      console.log(`════════════════════════════════════════════════════════════════`);

      for (const run of stuckRuns) {
        const age = Date.now() - run.snapshotCreatedAt.getTime();
        const ageMinutes = Math.floor(age / 1000 / 60);
        console.log(`  • Run: ${run.runId}`);
        console.log(`    Task: ${run.taskIdentifier}`);
        console.log(`    Queue: ${run.queue}`);
        console.log(`    Concurrency Key: ${run.concurrencyKey || "(none)"}`);
        console.log(`    Status: ${run.executionStatus}`);
        console.log(`    Stuck for: ${ageMinutes} minutes`);
        console.log(`    Snapshot created: ${run.snapshotCreatedAt.toISOString()}`);
        console.log();
      }

      // Prepare recovery operations
      console.log(`\n⚡ ${executeMode ? "Executing" : "Planning"} recovery for ${stuckRuns.length} stuck runs`);
      console.log(`This will:`);
      console.log(`  1. Add each run back to its specific queue sorted set`);
      console.log(`  2. Remove each run from the queue-specific currentConcurrency set`);
      console.log(`  3. Remove each run from the env-level currentConcurrency set`);
      console.log();

      let successCount = 0;
      let failureCount = 0;

      const currentTimestamp = Date.now();

      for (const run of stuckRuns) {
        try {
          // Build queue key: engine:runqueue:{org:X}:proj:Y:env:Z:queue:QUEUENAME
          // Build queue currentConcurrency key: engine:runqueue:{org:X}:proj:Y:env:Z:queue:QUEUENAME:currentConcurrency
          const queueKey = run.concurrencyKey
            ? `engine:runqueue:{org:${run.orgId}}:proj:${run.projectId}:env:${run.environmentId}:queue:${run.queue}:ck:${run.concurrencyKey}`
            : `engine:runqueue:{org:${run.orgId}}:proj:${run.projectId}:env:${run.environmentId}:queue:${run.queue}`;

          const queueConcurrencyKey = `${queueKey}:currentConcurrency`;

          const operations: RedisOperation[] = [
            {
              type: "ZADD",
              key: queueKey,
              args: [currentTimestamp, run.runId],
              description: `Add run to queue sorted set with score ${currentTimestamp}`,
            },
            {
              type: "SREM",
              key: queueConcurrencyKey,
              args: [run.runId],
              description: `Remove run from queue currentConcurrency set`,
            },
            {
              type: "SREM",
              key: envConcurrencyKey,
              args: [run.runId],
              description: `Remove run from env currentConcurrency set`,
            },
          ];

          if (executeMode && redisWrite) {
            // Execute operations using the write client
            await redisWrite.zadd(queueKey, currentTimestamp, run.runId);
            const removedFromQueue = await redisWrite.srem(queueConcurrencyKey, run.runId);
            const removedFromEnv = await redisWrite.srem(envConcurrencyKey, run.runId);

            console.log(`  ✓ Recovered run ${run.runId} (${run.taskIdentifier})`);
            if (removedFromQueue === 0) {
              console.log(`    ⚠ Run was not in queue currentConcurrency set`);
            }
            if (removedFromEnv === 0) {
              console.log(`    ⚠ Run was not in env currentConcurrency set`);
            }
            successCount++;
          } else {
            // Dry run - just show what would be done
            console.log(`  📝 Would recover run ${run.runId} (${run.taskIdentifier}):`);
            for (const op of operations) {
              console.log(`     ${op.type} ${op.key}`);
              console.log(`       Args: ${JSON.stringify(op.args)}`);
              console.log(`       (${op.description})`);
            }
            successCount++;
          }
        } catch (error) {
          console.error(`  ✗ Failed to recover run ${run.runId}:`, error);
          failureCount++;
        }
      }

      console.log(`\n═══════════════════════════════════════════════════════════════`);
      if (executeMode) {
        console.log(`✅ Recovery complete!`);
        console.log(`   Recovered: ${successCount}`);
        console.log(`   Failed: ${failureCount}`);
        console.log();
        console.log(`ℹ️  Note: The recovered runs should be automatically dequeued`);
        console.log(`   by the master queue consumers within a few seconds.`);
      } else {
        console.log(`📋 Dry run complete - no changes were made`);
        console.log(`   Would recover: ${successCount}`);
        console.log(`   Would fail: ${failureCount}`);
        console.log();
        console.log(`💡 To execute these changes, run again with a redisWriteUrl argument`);
      }
    } finally {
      await redisRead.quit();
      if (redisWrite) {
        await redisWrite.quit();
      }
    }
  } catch (error) {
    console.error("❌ Error during recovery:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
