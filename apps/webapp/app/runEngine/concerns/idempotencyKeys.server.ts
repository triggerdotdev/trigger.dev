import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import type { RunEngine } from "~/v3/runEngine.server";
import type { TraceEventConcern, TriggerTaskRequest } from "../types";

export type IdempotencyKeyConcernResult =
  | { isCached: true; run: TaskRun }
  | { isCached: false; idempotencyKey?: string; idempotencyKeyExpiresAt?: Date };

export class IdempotencyKeyConcern {
  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine,
    private readonly traceEventConcern: TraceEventConcern
  ) {}

  async handleTriggerRequest(request: TriggerTaskRequest): Promise<IdempotencyKeyConcernResult> {
    const idempotencyKey = request.options?.idempotencyKey ?? request.body.options?.idempotencyKey;
    const idempotencyKeyExpiresAt =
      request.options?.idempotencyKeyExpiresAt ??
      resolveIdempotencyKeyTTL(request.body.options?.idempotencyKeyTTL) ??
      new Date(Date.now() + 24 * 60 * 60 * 1000 * 30); // 30 days

    if (!idempotencyKey) {
      return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
    }

    const existingRun = idempotencyKey
      ? await this.prisma.taskRun.findFirst({
          where: {
            runtimeEnvironmentId: request.environment.id,
            idempotencyKey,
            taskIdentifier: request.taskId,
          },
          include: {
            associatedWaitpoint: true,
          },
        })
      : undefined;

    if (existingRun) {
      if (existingRun.idempotencyKeyExpiresAt && existingRun.idempotencyKeyExpiresAt < new Date()) {
        logger.debug("[TriggerTaskService][call] Idempotency key has expired", {
          idempotencyKey: request.options?.idempotencyKey,
          run: existingRun,
        });

        // Update the existing run to remove the idempotency key
        await this.prisma.taskRun.updateMany({
          where: { id: existingRun.id, idempotencyKey },
          data: { idempotencyKey: null, idempotencyKeyExpiresAt: null },
        });
      } else {
        const associatedWaitpoint = existingRun.associatedWaitpoint;
        const parentRunId = request.body.options?.parentRunId;
        const resumeParentOnCompletion = request.body.options?.resumeParentOnCompletion;
        //We're using `andWait` so we need to block the parent run with a waitpoint
        if (associatedWaitpoint && resumeParentOnCompletion && parentRunId) {
          await this.traceEventConcern.traceIdempotentRun(
            request,
            {
              existingRun,
              idempotencyKey,
              incomplete: associatedWaitpoint.status === "PENDING",
              isError: associatedWaitpoint.outputIsError,
            },
            async (event) => {
              //block run with waitpoint
              await this.engine.blockRunWithWaitpoint({
                runId: RunId.fromFriendlyId(parentRunId),
                waitpoints: associatedWaitpoint.id,
                spanIdToComplete: event.spanId,
                batch: request.options?.batchId
                  ? {
                      id: request.options.batchId,
                      index: request.options.batchIndex ?? 0,
                    }
                  : undefined,
                projectId: request.environment.projectId,
                organizationId: request.environment.organizationId,
                tx: this.prisma,
                releaseConcurrency: request.body.options?.releaseConcurrency,
              });
            }
          );
        }

        return { isCached: true, run: existingRun };
      }
    }

    return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
  }
}
