import { startSpan } from "@internal/tracing";
import { isFinalRunStatus } from "../statuses.js";
import { SystemResources } from "./systems.js";
import { WaitpointSystem } from "./waitpointSystem.js";

export type BatchSystemOptions = {
  resources: SystemResources;
  waitpointSystem: WaitpointSystem;
};

export class BatchSystem {
  private readonly $: SystemResources;
  private readonly waitpointSystem: WaitpointSystem;

  constructor(private readonly options: BatchSystemOptions) {
    this.$ = options.resources;
    this.waitpointSystem = options.waitpointSystem;
  }

  public async scheduleCompleteBatch({ batchId }: { batchId: string }): Promise<void> {
    await this.$.worker.enqueue({
      //this will debounce the call
      id: `tryCompleteBatch:${batchId}`,
      job: "tryCompleteBatch",
      payload: { batchId: batchId },
      //200ms in the future
      availableAt: new Date(Date.now() + 200),
    });
  }

  public async performCompleteBatch({ batchId }: { batchId: string }): Promise<void> {
    await this.#tryCompleteBatch({ batchId });
  }

  /**
   * Checks to see if all runs for a BatchTaskRun are completed, if they are then update the status.
   * This isn't used operationally, but it's used for the Batches dashboard page.
   */
  async #tryCompleteBatch({ batchId }: { batchId: string }) {
    return startSpan(this.$.tracer, "#tryCompleteBatch", async (span) => {
      const batch = await this.$.prisma.batchTaskRun.findFirst({
        select: {
          status: true,
          runtimeEnvironmentId: true,
          processingJobsCount: true,
          runCount: true,
          batchVersion: true,
          successfulRunCount: true,
          failedRunCount: true,
        },
        where: {
          id: batchId,
        },
      });

      if (!batch) {
        this.$.logger.error("#tryCompleteBatch batch doesn't exist", { batchId });
        return;
      }

      if (batch.status === "COMPLETED") {
        this.$.logger.debug("#tryCompleteBatch: Batch already completed", { batchId });
        return;
      }

      // Check if all runs are created (or accounted for with failures)
      // v2 batches use successfulRunCount + failedRunCount, v1 uses processingJobsCount
      const isNewBatch = batch.batchVersion === "runengine:v2";

      let processedRunCount: number;
      if (isNewBatch) {
        // For v2/v3 batches, we need to count both successful and failed runs
        const successfulCount = batch.successfulRunCount ?? 0;
        const failedCount = batch.failedRunCount ?? 0;
        processedRunCount = successfulCount + failedCount;
      } else {
        processedRunCount = batch.processingJobsCount;
      }

      if (processedRunCount < batch.runCount) {
        this.$.logger.debug("#tryCompleteBatch: Not all runs are processed yet", {
          batchId,
          processedRunCount,
          runCount: batch.runCount,
          isNewBatch,
        });
        return;
      }

      const runs = await this.$.prisma.taskRun.findMany({
        select: {
          id: true,
          status: true,
        },
        where: {
          batchId,
          runtimeEnvironmentId: batch.runtimeEnvironmentId,
        },
      });

      if (runs.every((r) => isFinalRunStatus(r.status))) {
        this.$.logger.debug("#tryCompleteBatch: All runs are completed", { batchId });
        await this.$.prisma.batchTaskRun.update({
          where: {
            id: batchId,
          },
          data: {
            status: "COMPLETED",
          },
        });

        //get waitpoint (if there is one)
        const waitpoint = await this.$.prisma.waitpoint.findFirst({
          where: {
            completedByBatchId: batchId,
          },
        });

        if (!waitpoint) {
          this.$.logger.debug(
            "RunEngine.unblockRunForBatch(): Waitpoint not found. This is ok, because only batchTriggerAndWait has waitpoints",
            {
              batchId,
            }
          );
          return;
        }

        await this.waitpointSystem.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "Batch waitpoint completed", isError: false },
        });
      } else {
        this.$.logger.debug("#tryCompleteBatch: Not all runs are completed", { batchId });
      }
    });
  }
}
