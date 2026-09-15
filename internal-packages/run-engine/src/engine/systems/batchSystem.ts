import { startSpan, type Counter } from "@internal/tracing";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { isFinalRunStatus } from "../statuses.js";
import type { SystemResources } from "./systems.js";
import type { WaitpointSystem } from "./waitpointSystem.js";

export type BatchSystemOptions = {
  resources: SystemResources;
  waitpointSystem: WaitpointSystem;
};

export class BatchSystem {
  private readonly $: SystemResources;
  private readonly waitpointSystem: WaitpointSystem;
  private readonly expirationsCounter: Counter;

  constructor(private readonly options: BatchSystemOptions) {
    this.$ = options.resources;
    this.waitpointSystem = options.waitpointSystem;
    this.expirationsCounter = this.$.meter.createCounter("batch_system.expirations", {
      description: "Seal-timeout reaper runs, by outcome",
      unit: "batches",
    });
  }

  public async scheduleCompleteBatch({ batchId }: { batchId: string }): Promise<void> {
    await this.$.worker.enqueue({
      //this will debounce the call
      id: `tryCompleteBatch:${batchId}`,
      job: "tryCompleteBatch",
      payload: { batchId: batchId },
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
      id: `expireBatch:${batchId}`,
      job: "expireBatch",
      payload: { batchId },
      availableAt,
    });
  }

  /**
   * Terminally fail a batch whose phase 2 item stream never sealed it, completing the
   * parent's batchTriggerAndWait waitpoint with an error so the parent resumes with a
   * failure instead of hanging forever.
   *
   * A batch is only sealed once every item has streamed, but the parent is blocked on the
   * batch's waitpoint from the moment the batch is created. Nothing else completes that
   * waitpoint, so without this a stream that never finishes strands the parent permanently.
   *
   * Idempotent and race-safe: a batch that sealed in the meantime is left alone.
   *
   * Resumable too. The abort and the waitpoint completion are two writes, so a crash between
   * them would otherwise leave the parent blocked with no way back: the retry would see a
   * non-PENDING batch and bail. An already-ABORTED batch therefore falls through to complete
   * its waitpoint again, which {@link WaitpointSystem.completeWaitpoint} treats as a no-op.
   */
  public async expireBatch({ batchId }: { batchId: string }): Promise<void> {
    return startSpan(this.$.tracer, "expireBatch", async (span) => {
      span.setAttribute("batchId", batchId);

      const batch = await this.$.runStore.findBatchTaskRunById(batchId, undefined, this.$.prisma);

      if (!batch) {
        this.$.logger.debug("expireBatch: batch doesn't exist", { batchId });
        this.expirationsCounter.add(1, { outcome: "missing" });
        return;
      }

      if (batch.sealed || (batch.status !== "PENDING" && batch.status !== "ABORTED")) {
        this.$.logger.debug("expireBatch: batch sealed or already finished, nothing to do", {
          batchId,
          status: batch.status,
          sealed: batch.sealed,
        });
        this.expirationsCounter.add(1, { outcome: "already_settled" });
        return;
      }

      if (batch.status === "PENDING") {
        const aborted = await this.$.runStore.updateManyBatchTaskRun(
          {
            where: { id: batchId, sealed: false, status: "PENDING" },
            data: {
              status: "ABORTED",
              completedAt: new Date(),
              processingCompletedAt: new Date(),
            },
          },
          this.$.prisma
        );

        if (aborted.count === 0) {
          const current = await this.$.runStore.findBatchTaskRunById(
            batchId,
            undefined,
            this.$.prisma
          );

          if (!current || current.sealed || current.status !== "ABORTED") {
            this.$.logger.debug("expireBatch: lost the race to a seal, no-op", { batchId });
            this.expirationsCounter.add(1, { outcome: "lost_race" });
            return;
          }
        }
      }

      const waitpoint = await this.$.runStore.findWaitpoint(
        {
          where: { completedByBatchId: batchId },
        },
        this.$.prisma
      );

      if (!waitpoint) {
        this.$.logger.debug("expireBatch: no waitpoint, nothing was blocked on this batch", {
          batchId,
        });
        this.expirationsCounter.add(1, { outcome: "aborted_no_parent" });
        return;
      }

      const error: TaskRunError = {
        type: "STRING_ERROR",
        raw:
          `Batch ${batch.friendlyId} was never fully created: its ${batch.expectedCount} ` +
          `items could not be streamed before it timed out, so the batch can never complete. ` +
          `batchTriggerAndWait failed rather than waiting forever.`,
      };

      await this.waitpointSystem.completeWaitpoint({
        id: waitpoint.id,
        output: { value: JSON.stringify(error), isError: true },
      });

      this.expirationsCounter.add(1, { outcome: "aborted_parent_resumed" });

      this.$.logger.warn("expireBatch: aborted an unsealed batch and resumed its parent", {
        batchId,
        waitpointId: waitpoint.id,
        expectedCount: batch.expectedCount,
      });
    });
  }

  /**
   * Checks to see if all runs for a BatchTaskRun are completed, if they are then update the status.
   * This isn't used operationally, but it's used for the Batches dashboard page.
   */
  async #tryCompleteBatch({ batchId }: { batchId: string }) {
    return startSpan(this.$.tracer, "#tryCompleteBatch", async (span) => {
      const batch = await this.$.runStore.findBatchTaskRunById(batchId, undefined, this.$.prisma);

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

        const completed = await this.$.runStore.updateManyBatchTaskRun(
          {
            where: { id: batchId, status: { notIn: ["ABORTED", "COMPLETED"] } },
            data: { status: "COMPLETED" },
          },
          this.$.prisma
        );

        if (completed.count === 0) {
          this.$.logger.debug("#tryCompleteBatch: batch already reached a terminal status", {
            batchId,
          });
          return;
        }

        //get waitpoint (if there is one)
        const waitpoint = await this.$.runStore.findWaitpoint(
          {
            where: {
              completedByBatchId: batchId,
            },
          },
          this.$.prisma
        );

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
