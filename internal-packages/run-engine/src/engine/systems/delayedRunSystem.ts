import { startSpan } from "@internal/tracing";
import { SystemResources } from "./systems.js";
import { PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import { EnqueueSystem } from "./enqueueSystem.js";
import { ServiceValidationError } from "../errors.js";

export type DelayedRunSystemOptions = {
  resources: SystemResources;
  enqueueSystem: EnqueueSystem;
};

export class DelayedRunSystem {
  private readonly $: SystemResources;
  private readonly enqueueSystem: EnqueueSystem;

  constructor(private readonly options: DelayedRunSystemOptions) {
    this.$ = options.resources;
    this.enqueueSystem = options.enqueueSystem;
  }

  /**
   * Reschedules a delayed run where the run hasn't been queued yet
   */
  async rescheduleDelayedRun({
    runId,
    delayUntil,
    tx,
  }: {
    runId: string;
    delayUntil: Date;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRun> {
    const prisma = tx ?? this.$.prisma;
    return startSpan(
      this.$.tracer,
      "rescheduleDelayedRun",
      async () => {
        return await this.$.runLock.lock([runId], 5_000, async () => {
          const snapshot = await getLatestExecutionSnapshot(prisma, runId);

          //if the run isn't just created then we can't reschedule it
          if (snapshot.executionStatus !== "RUN_CREATED") {
            throw new ServiceValidationError("Cannot reschedule a run that is not delayed");
          }

          const updatedRun = await prisma.taskRun.update({
            where: {
              id: runId,
            },
            data: {
              delayUntil: delayUntil,
              executionSnapshots: {
                create: {
                  engine: "V2",
                  executionStatus: "RUN_CREATED",
                  description: "Delayed run was rescheduled to a future date",
                  runStatus: "EXPIRED",
                  environmentId: snapshot.environmentId,
                  environmentType: snapshot.environmentType,
                  projectId: snapshot.projectId,
                  organizationId: snapshot.organizationId,
                },
              },
            },
          });

          await this.$.worker.reschedule(`enqueueDelayedRun:${updatedRun.id}`, delayUntil);

          return updatedRun;
        });
      },
      {
        attributes: { runId },
      }
    );
  }

  async enqueueDelayedRun({ runId }: { runId: string }) {
    const run = await this.$.prisma.taskRun.findFirst({
      where: { id: runId },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
      },
    });

    if (!run) {
      throw new Error(`#enqueueDelayedRun: run not found: ${runId}`);
    }

    // Now we need to enqueue the run into the RunQueue
    await this.enqueueSystem.enqueueRun({
      run,
      env: run.runtimeEnvironment,
      batchId: run.batchId ?? undefined,
    });

    await this.$.prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "PENDING",
        queuedAt: new Date(),
      },
    });

    if (run.ttl) {
      const expireAt = parseNaturalLanguageDuration(run.ttl);

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

  async scheduleDelayedRunEnqueuing({ runId, delayUntil }: { runId: string; delayUntil: Date }) {
    await this.$.worker.enqueue({
      id: `enqueueDelayedRun:${runId}`,
      job: "enqueueDelayedRun",
      payload: { runId },
      availableAt: delayUntil,
    });
  }
}
