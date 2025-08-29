import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { ServiceValidationError } from "../errors.js";
import { isExecuting } from "../statuses.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { SystemResources } from "./systems.js";
import { WaitpointSystem } from "./waitpointSystem.js";

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

      if (!updatedRun.associatedWaitpoint) {
        throw new ServiceValidationError("No associated waitpoint found", 400);
      }

      await this.waitpointSystem.completeWaitpoint({
        id: updatedRun.associatedWaitpoint.id,
        output: { value: JSON.stringify(error), isError: true },
      });

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
}
