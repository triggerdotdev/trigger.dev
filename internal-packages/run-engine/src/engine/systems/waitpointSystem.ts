import {
  $transaction,
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  Waitpoint,
} from "@trigger.dev/database";
import { EventBus } from "../eventBus.js";
import { EngineWorker } from "../types.js";
import { Logger } from "@trigger.dev/core/logger";
import { Tracer } from "@internal/tracing";

export type WaitpointSystemOptions = {
  prisma: PrismaClient;
  worker: EngineWorker;
  eventBus: EventBus;
  logger: Logger;
  tracer: Tracer;
};

export class WaitpointSystem {
  private readonly prisma: PrismaClient;
  private readonly worker: EngineWorker;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly tracer: Tracer;

  constructor(private readonly options: WaitpointSystemOptions) {
    this.prisma = options.prisma;
    this.worker = options.worker;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.tracer = options.tracer;
  }

  public async clearBlockingWaitpoints({
    runId,
    tx,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;
    const deleted = await prisma.taskRunWaitpoint.deleteMany({
      where: {
        taskRunId: runId,
      },
    });

    return deleted.count;
  }

  /** This completes a waitpoint and updates all entries so the run isn't blocked,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async completeWaitpoint({
    id,
    output,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
  }): Promise<Waitpoint> {
    const result = await $transaction(
      this.prisma,
      async (tx) => {
        // 1. Find the TaskRuns blocked by this waitpoint
        const affectedTaskRuns = await tx.taskRunWaitpoint.findMany({
          where: { waitpointId: id },
          select: { taskRunId: true, spanIdToComplete: true, createdAt: true },
        });

        if (affectedTaskRuns.length === 0) {
          this.logger.warn(`completeWaitpoint: No TaskRunWaitpoints found for waitpoint`, {
            waitpointId: id,
          });
        }

        // 2. Update the waitpoint to completed (only if it's pending)
        let waitpoint: Waitpoint | null = null;
        try {
          waitpoint = await tx.waitpoint.update({
            where: { id, status: "PENDING" },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              output: output?.value,
              outputType: output?.type,
              outputIsError: output?.isError,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            waitpoint = await tx.waitpoint.findFirst({
              where: { id },
            });
          } else {
            this.logger.log("completeWaitpoint: error updating waitpoint:", { error });
            throw error;
          }
        }

        return { waitpoint, affectedTaskRuns };
      },
      (error) => {
        this.logger.error(`completeWaitpoint: Error completing waitpoint ${id}, retrying`, {
          error,
        });
        throw error;
      }
    );

    if (!result) {
      throw new Error(`Waitpoint couldn't be updated`);
    }

    if (!result.waitpoint) {
      throw new Error(`Waitpoint ${id} not found`);
    }

    //schedule trying to continue the runs
    for (const run of result.affectedTaskRuns) {
      await this.worker.enqueue({
        //this will debounce the call
        id: `continueRunIfUnblocked:${run.taskRunId}`,
        job: "continueRunIfUnblocked",
        payload: { runId: run.taskRunId },
        //50ms in the future
        availableAt: new Date(Date.now() + 50),
      });

      // emit an event to complete associated cached runs
      if (run.spanIdToComplete) {
        this.eventBus.emit("cachedRunCompleted", {
          time: new Date(),
          span: {
            id: run.spanIdToComplete,
            createdAt: run.createdAt,
          },
          blockedRunId: run.taskRunId,
          hasError: output?.isError ?? false,
        });
      }
    }

    return result.waitpoint;
  }
}
