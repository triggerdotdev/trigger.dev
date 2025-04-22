import { PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import { TriggerTaskRequest } from "../types";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { logger } from "~/services/logger.server";
import { eventRepository } from "~/v3/eventRepository.server";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3/semanticInternalAttributes";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { RunEngine } from "~/v3/runEngine.server";

export type IdempotencyKeyConcernResult =
  | { isCached: true; run: TaskRun }
  | { isCached: false; idempotencyKey?: string; idempotencyKeyExpiresAt?: Date };

export class IdempotencyKeyConcern {
  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine
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
        await this.prisma.taskRun.update({
          where: { id: existingRun.id },
          data: { idempotencyKey: null },
        });
      } else {
        //We're using `andWait` so we need to block the parent run with a waitpoint
        if (
          existingRun.associatedWaitpoint &&
          request.body.options?.resumeParentOnCompletion &&
          request.body.options?.parentRunId
        ) {
          await eventRepository.traceEvent(
            `${request.taskId} (cached)`,
            {
              context: request.options?.traceContext,
              spanParentAsLink: request.options?.spanParentAsLink,
              parentAsLinkType: request.options?.parentAsLinkType,
              kind: "SERVER",
              environment: request.environment,
              taskSlug: request.taskId,
              attributes: {
                properties: {
                  [SemanticInternalAttributes.SHOW_ACTIONS]: true,
                  [SemanticInternalAttributes.ORIGINAL_RUN_ID]: existingRun.friendlyId,
                },
                style: {
                  icon: "task-cached",
                },
                runIsTest: request.body.options?.test ?? false,
                batchId: request.options?.batchId
                  ? BatchId.toFriendlyId(request.options.batchId)
                  : undefined,
                idempotencyKey,
                runId: existingRun.friendlyId,
              },
              incomplete: existingRun.associatedWaitpoint.status === "PENDING",
              isError: existingRun.associatedWaitpoint.outputIsError,
              immediate: true,
            },
            async (event) => {
              //log a message
              await eventRepository.recordEvent(
                `There's an existing run for idempotencyKey: ${idempotencyKey}`,
                {
                  taskSlug: request.taskId,
                  environment: request.environment,
                  attributes: {
                    runId: existingRun.friendlyId,
                  },
                  context: request.options?.traceContext,
                  parentId: event.spanId,
                }
              );
              //block run with waitpoint
              await this.engine.blockRunWithWaitpoint({
                runId: RunId.fromFriendlyId(request.body.options!.parentRunId!),
                waitpoints: existingRun.associatedWaitpoint!.id,
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
