import { startSpan } from "@internal/tracing";
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
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

  public async scheduleExpireBatch({
    batchId,
    availableAt,
  }: {
    batchId: string;
    availableAt: Date;
  }): Promise<void> {
    await this.$.worker.enqueue({
      // Stable id dedupes repeated schedules for the same batch.
      id: `expireBatch:${batchId}`,
      job: "expireBatch",
      payload: { batchId },
      availableAt,
    });
  }

  /**
   * Terminally fail a batch whose Phase 2 item stream never sealed it, and resolve
   * the parent's batchTriggerAndWait waitpoint with an error so the parent resumes
   * with a failure instead of hanging forever.
   *
   * Idempotent and race-safe: if the stream sealed the batch (or it otherwise
   * progressed past an unsealed PENDING state) in the meantime, this is a no-op.
   */
  public async expireBatch({ batchId }: { batchId: string }): Promise<void> {
    return startSpan(this.$.tracer, "expireBatch", async (span) => {
      span.setAttribute("batchId", batchId);

      const batch = await this.$.prisma.batchTaskRun.findFirst({
        select: { status: true, sealed: true, processingCompletedAt: true },
        where: { id: batchId },
      });

      if (!batch) {
        this.$.logger.debug("expireBatch: batch doesn't exist", { batchId });
        return;
      }

      // The stream sealed the batch, so the normal completion path owns it.
      if (batch.sealed) {
        this.$.logger.debug("expireBatch: batch already sealed", { batchId });
        return;
      }

      // Terminal states other than ABORTED are done. ABORTED falls through on
      // purpose: a previous attempt may have aborted the batch but crashed before
      // resolving the waitpoint, and completeWaitpoint is idempotent, so retrying
      // can't leave the parent blocked.
      if (batch.status !== "PENDING" && batch.status !== "ABORTED") {
        this.$.logger.debug("expireBatch: batch in terminal non-aborted state", {
          batchId,
          status: batch.status,
        });
        return;
      }

      // The BatchQueue already processed every item (the completion callback set
      // processingCompletedAt) even though the seal never landed — the runs exist
      // and will resume the parent on their own. Aborting would fail a healthy batch.
      if (batch.status === "PENDING" && batch.processingCompletedAt !== null) {
        this.$.logger.debug("expireBatch: items already processed, not aborting", { batchId });
        return;
      }

      if (batch.status === "PENDING") {
        // Conditional update guards against racing a late seal or completion —
        // whichever loses no-ops.
        const aborted = await this.$.prisma.batchTaskRun.updateMany({
          where: { id: batchId, sealed: false, status: "PENDING", processingCompletedAt: null },
          data: {
            status: "ABORTED",
            completedAt: new Date(),
          },
        });

        if (aborted.count === 0) {
          this.$.logger.debug("expireBatch: lost race to seal/complete, no-op", { batchId });
          return;
        }
      }

      // Only batchTriggerAndWait blocks a parent, so only it has a waitpoint to
      // resolve. The status filter keeps this idempotent if a previous attempt
      // already resolved it.
      const waitpoint = await this.$.prisma.waitpoint.findFirst({
        where: { completedByBatchId: batchId, status: "PENDING" },
      });

      if (!waitpoint) {
        this.$.logger.debug("expireBatch: no pending waitpoint to resolve", { batchId });
        return;
      }

      const error: TaskRunError = {
        type: "STRING_ERROR",
        raw: "Batch items could not be streamed before the batch timed out",
      };

      await this.waitpointSystem.completeWaitpoint({
        id: waitpoint.id,
        output: { value: JSON.stringify(error), isError: true },
      });

      this.$.logger.warn("expireBatch: aborted unsealed batch and resumed parent with error", {
        batchId,
        waitpointId: waitpoint.id,
      });
    });
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

      if (batch.status === "COMPLETED" || batch.status === "ABORTED") {
        this.$.logger.debug("#tryCompleteBatch: Batch already in a terminal status", {
          batchId,
          status: batch.status,
        });
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

      const runs = await this.$.runStore.findRuns(
        {
          select: {
            id: true,
            status: true,
          },
          where: {
            batchId,
            runtimeEnvironmentId: batch.runtimeEnvironmentId,
          },
        },
        this.$.prisma
      );

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
