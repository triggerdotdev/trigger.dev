import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { PrismaClientOrTransaction, TaskRunStatus } from "@trigger.dev/database";
import { isExecuting } from "../statuses.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { SystemResources } from "./systems.js";
import { WaitpointSystem } from "./waitpointSystem.js";
import { startSpan } from "@internal/tracing";

export type TtlSystemOptions = {
  resources: SystemResources;
  waitpointSystem: WaitpointSystem;
};

export class TtlSystem {
  private readonly $: SystemResources;
  private readonly waitpointSystem: WaitpointSystem;

  constructor(private readonly options: TtlSystemOptions) {
    this.$ = options.resources;
    this.waitpointSystem = options.waitpointSystem;
  }

  async expireRun({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {
    const prisma = tx ?? this.$.prisma;
    await this.$.runLock.lock("expireRun", [runId], async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

      //if we're executing then we won't expire the run
      if (isExecuting(snapshot.executionStatus)) {
        return;
      }

      //only expire "PENDING" runs
      const run = await prisma.taskRun.findFirst({ where: { id: runId } });

      if (!run) {
        this.$.logger.debug("Could not find enqueued run to expire", {
          runId,
        });
        return;
      }

      if (run.status !== "PENDING") {
        this.$.logger.debug("Run cannot be expired because it's not in PENDING status", {
          run,
        });
        return;
      }

      if (run.lockedAt) {
        this.$.logger.debug("Run cannot be expired because it's locked, so will run", {
          run,
        });
        return;
      }

      const error: TaskRunError = {
        type: "STRING_ERROR",
        raw: `Run expired because the TTL (${run.ttl}) was reached`,
      };

      const updatedRun = await prisma.taskRun.update({
        where: { id: runId },
        data: {
          status: "EXPIRED",
          completedAt: new Date(),
          expiredAt: new Date(),
          error,
          executionSnapshots: {
            create: {
              engine: "V2",
              executionStatus: "FINISHED",
              description: "Run was expired because the TTL was reached",
              runStatus: "EXPIRED",
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
              projectId: snapshot.projectId,
              organizationId: snapshot.organizationId,
            },
          },
        },
        select: {
          id: true,
          spanId: true,
          ttl: true,
          updatedAt: true,
          associatedWaitpoint: {
            select: {
              id: true,
            },
          },
          runtimeEnvironment: {
            select: {
              organizationId: true,
              projectId: true,
              id: true,
            },
          },
          createdAt: true,
          completedAt: true,
          taskEventStore: true,
          parentTaskRunId: true,
          expiredAt: true,
          status: true,
        },
      });

      await this.$.runQueue.acknowledgeMessage(
        updatedRun.runtimeEnvironment.organizationId,
        runId,
        {
          removeFromWorkerQueue: true,
        }
      );

      // Complete the waitpoint if it exists (runs without waiting parents have no waitpoint)
      if (updatedRun.associatedWaitpoint) {
        await this.waitpointSystem.completeWaitpoint({
          id: updatedRun.associatedWaitpoint.id,
          output: { value: JSON.stringify(error), isError: true },
        });
      }

      this.$.eventBus.emit("runExpired", {
        run: updatedRun,
        time: new Date(),
        organization: { id: updatedRun.runtimeEnvironment.organizationId },
        project: { id: updatedRun.runtimeEnvironment.projectId },
        environment: { id: updatedRun.runtimeEnvironment.id },
      });
    });
  }

  async scheduleExpireRun({ runId, ttl }: { runId: string; ttl: string }) {
    const expireAt = parseNaturalLanguageDuration(ttl);

    if (expireAt) {
      await this.$.worker.enqueue({
        id: `expireRun:${runId}`,
        job: "expireRun",
        payload: { runId },
        availableAt: expireAt,
      });
    }
  }

  /**
   * Efficiently expire a batch of runs that were already atomically removed from
   * the queue by the TTL Lua script. This method:
   * - Does NOT use run locks (the Lua script already claimed these atomically)
   * - Does NOT call acknowledgeMessage (the Lua script already removed from queue)
   * - Batches database operations where possible
   */
  async expireRunsBatch(runIds: string[]): Promise<{
    expired: string[];
    skipped: { runId: string; reason: string }[];
  }> {
    return startSpan(
      this.$.tracer,
      "TtlSystem.expireRunsBatch",
      async (span) => {
        span.setAttribute("runCount", runIds.length);

        if (runIds.length === 0) {
          return { expired: [], skipped: [] };
        }

        const expired: string[] = [];
        const skipped: { runId: string; reason: string }[] = [];

        // Fetch all runs with their snapshots in a single query
        const runs = await this.$.prisma.taskRun.findMany({
          where: { id: { in: runIds } },
          select: {
            id: true,
            spanId: true,
            status: true,
            lockedAt: true,
            ttl: true,
            taskEventStore: true,
            createdAt: true,
            associatedWaitpoint: { select: { id: true } },
            runtimeEnvironment: {
              select: {
                id: true,
                organizationId: true,
                projectId: true,
              },
            },
            executionSnapshots: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                executionStatus: true,
                environmentId: true,
                environmentType: true,
                projectId: true,
                organizationId: true,
              },
            },
          },
        });

        // Filter runs that can be expired
        const runsToExpire: typeof runs = [];

        for (const run of runs) {
          const latestSnapshot = run.executionSnapshots[0];

          if (!latestSnapshot) {
            skipped.push({ runId: run.id, reason: "no_snapshot" });
            continue;
          }

          if (isExecuting(latestSnapshot.executionStatus)) {
            skipped.push({ runId: run.id, reason: "executing" });
            continue;
          }

          if (run.status !== "PENDING") {
            skipped.push({ runId: run.id, reason: `status_${run.status}` });
            continue;
          }

          if (run.lockedAt) {
            skipped.push({ runId: run.id, reason: "locked" });
            continue;
          }

          runsToExpire.push(run);
        }

        // Track runs that weren't found
        const foundRunIds = new Set(runs.map((r) => r.id));
        for (const runId of runIds) {
          if (!foundRunIds.has(runId)) {
            skipped.push({ runId, reason: "not_found" });
          }
        }

        if (runsToExpire.length === 0) {
          span.setAttribute("expiredCount", 0);
          span.setAttribute("skippedCount", skipped.length);
          return { expired, skipped };
        }

        // Update all runs in a single batch
        const now = new Date();
        const runIdsToExpire = runsToExpire.map((r) => r.id);

        await this.$.prisma.taskRun.updateMany({
          where: { id: { in: runIdsToExpire } },
          data: {
            status: "EXPIRED" as TaskRunStatus,
            completedAt: now,
            expiredAt: now,
            // Note: updateMany doesn't support nested writes, so we handle error and snapshots separately
          },
        });

        // Create snapshots and set errors for each run (these require individual updates)
        await Promise.all(
          runsToExpire.map(async (run) => {
            const latestSnapshot = run.executionSnapshots[0]!;
            const error: TaskRunError = {
              type: "STRING_ERROR",
              raw: `Run expired because the TTL (${run.ttl}) was reached`,
            };

            // Update the error field (updateMany can't do JSON fields properly)
            await this.$.prisma.taskRun.update({
              where: { id: run.id },
              data: { error },
            });

            // Create the snapshot
            await this.$.prisma.taskRunExecutionSnapshot.create({
              data: {
                runId: run.id,
                engine: "V2",
                executionStatus: "FINISHED",
                description: "Run was expired because the TTL was reached",
                runStatus: "EXPIRED",
                environmentId: latestSnapshot.environmentId,
                environmentType: latestSnapshot.environmentType,
                projectId: latestSnapshot.projectId,
                organizationId: latestSnapshot.organizationId,
              },
            });

            // Complete the waitpoint
            if (run.associatedWaitpoint) {
              await this.waitpointSystem.completeWaitpoint({
                id: run.associatedWaitpoint.id,
                output: { value: JSON.stringify(error), isError: true },
              });
            }

            // Emit event
            this.$.eventBus.emit("runExpired", {
              run: {
                id: run.id,
                spanId: run.spanId,
                ttl: run.ttl,
                taskEventStore: run.taskEventStore,
                createdAt: run.createdAt,
                updatedAt: now,
                completedAt: now,
                expiredAt: now,
                status: "EXPIRED" as TaskRunStatus,
              },
              time: now,
              organization: { id: run.runtimeEnvironment.organizationId },
              project: { id: run.runtimeEnvironment.projectId },
              environment: { id: run.runtimeEnvironment.id },
            });

            expired.push(run.id);
          })
        );

        span.setAttribute("expiredCount", expired.length);
        span.setAttribute("skippedCount", skipped.length);

        return { expired, skipped };
      }
    );
  }
}
