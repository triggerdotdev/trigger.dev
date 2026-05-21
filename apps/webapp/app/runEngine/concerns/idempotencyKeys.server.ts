import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { RunEngine } from "~/v3/runEngine.server";
import { shouldIdempotencyKeyBeCleared } from "~/v3/taskStatus";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { claimOrAwait } from "~/v3/mollifier/idempotencyClaim.server";
import type { TraceEventConcern, TriggerTaskRequest } from "../types";

// Claim ownership context returned to the caller when the
// IdempotencyKeyConcern won a pre-gate claim. Caller MUST publish the
// winning runId on pipeline success (`publishClaim`) or release the
// claim on failure (`releaseClaim`).
export type ClaimedIdempotency = {
  envId: string;
  taskIdentifier: string;
  idempotencyKey: string;
};

export type IdempotencyKeyConcernResult =
  | { isCached: true; run: TaskRun }
  | {
      isCached: false;
      idempotencyKey?: string;
      idempotencyKeyExpiresAt?: Date;
      // Set when this trigger holds a pre-gate claim. The caller's
      // trigger pipeline MUST resolve the claim by either publishing
      // the runId on success or releasing on failure. Undefined when
      // the request has no idempotency key, when the buffer is
      // unavailable, or when the request is a triggerAndWait (claim
      // path skipped per plan doc).
      claim?: ClaimedIdempotency;
    };

export class IdempotencyKeyConcern {
  constructor(
    private readonly prisma: PrismaClientOrTransaction,
    private readonly engine: RunEngine,
    private readonly traceEventConcern: TraceEventConcern
  ) {}

  // Q5 buffer-side dedup. Resolves an idempotency key against the
  // mollifier buffer when PG missed. Returns a SyntheticRun cast to
  // TaskRun so the route handler (which only reads run.id / run.friendlyId)
  // can echo the buffered run's friendlyId as a cached hit. Returns null
  // for any failure or miss — buffer outages must not 500 the trigger
  // hot path; we fail open to "no cache hit" and let the request through.
  private async findBufferedRunWithIdempotency(
    environmentId: string,
    organizationId: string,
    taskIdentifier: string,
    idempotencyKey: string,
  ): Promise<TaskRun | null> {
    const buffer = getMollifierBuffer();
    if (!buffer) return null;

    let bufferedRunId: string | null;
    try {
      bufferedRunId = await buffer.lookupIdempotency({
        envId: environmentId,
        taskIdentifier,
        idempotencyKey,
      });
    } catch (err) {
      logger.error("IdempotencyKeyConcern: buffer lookupIdempotency failed", {
        environmentId,
        taskIdentifier,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!bufferedRunId) return null;

    const synthetic = await findRunByIdWithMollifierFallback({
      runId: bufferedRunId,
      environmentId,
      organizationId,
    });
    if (!synthetic) return null;
    return synthetic as unknown as TaskRun;
  }

  async handleTriggerRequest(
    request: TriggerTaskRequest,
    parentStore: string | undefined
  ): Promise<IdempotencyKeyConcernResult> {
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

    // Buffer fallback per Q5 mollifier-idempotency design. PG missed —
    // the same key may belong to a buffered run that hasn't materialised
    // yet. Skipped when `resumeParentOnCompletion` is set: blocking a
    // parent on a buffered child via waitpoint requires a PG row that
    // doesn't exist yet. The follow-up accept's SETNX in mollifyTrigger
    // still dedupes the trigger itself; the waitpoint just doesn't fire
    // for this rare race window.
    if (!existingRun && idempotencyKey && !request.body.options?.resumeParentOnCompletion) {
      const buffered = await this.findBufferedRunWithIdempotency(
        request.environment.id,
        request.environment.organizationId,
        request.taskId,
        idempotencyKey,
      );
      if (buffered) {
        return { isCached: true, run: buffered };
      }
    }

    if (existingRun) {
      // The idempotency key has expired
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

        return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
      }

      // If the existing run failed or was expired, we clear the key and do a new run
      if (shouldIdempotencyKeyBeCleared(existingRun.status)) {
        logger.debug("[TriggerTaskService][call] Idempotency key should be cleared", {
          idempotencyKey: request.options?.idempotencyKey,
          runStatus: existingRun.status,
          runId: existingRun.id,
        });

        // Update the existing run to remove the idempotency key
        await this.prisma.taskRun.updateMany({
          where: { id: existingRun.id, idempotencyKey },
          data: { idempotencyKey: null, idempotencyKeyExpiresAt: null },
        });

        return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
      }

      // We have an idempotent run, so we return it
      const parentRunId = request.body.options?.parentRunId;
      const resumeParentOnCompletion = request.body.options?.resumeParentOnCompletion;

      //We're using `andWait` so we need to block the parent run with a waitpoint
      if (resumeParentOnCompletion && parentRunId) {
        // Get or create waitpoint lazily (existing run may not have one if it was standalone)
        let associatedWaitpoint = existingRun.associatedWaitpoint;
        if (!associatedWaitpoint) {
          associatedWaitpoint = await this.engine.getOrCreateRunWaitpoint({
            runId: existingRun.id,
            projectId: request.environment.projectId,
            environmentId: request.environment.id,
          });
        }

        await this.traceEventConcern.traceIdempotentRun(
          request,
          parentStore,
          {
            existingRun,
            idempotencyKey,
            incomplete: associatedWaitpoint.status === "PENDING",
            isError: associatedWaitpoint.outputIsError,
          },
          async (event) => {
            const spanId =
              request.options?.parentAsLinkType === "replay"
                ? event.spanId
                : event.traceparent?.spanId
                  ? `${event.traceparent.spanId}:${event.spanId}`
                  : event.spanId;

            //block run with waitpoint
            await this.engine.blockRunWithWaitpoint({
              runId: RunId.fromFriendlyId(parentRunId),
              waitpoints: associatedWaitpoint!.id,
              spanIdToComplete: spanId,
              batch: request.options?.batchId
                ? {
                    id: request.options.batchId,
                    index: request.options.batchIndex ?? 0,
                  }
                : undefined,
              projectId: request.environment.projectId,
              organizationId: request.environment.organizationId,
              tx: this.prisma,
            });
          }
        );
      }

      return { isCached: true, run: existingRun };
    }

    // Pre-gate claim — closes the PG+buffer race during gate transition
    // (see _plans/2026-05-21-mollifier-idempotency-claim.md). All
    // same-key triggers serialise here before evaluateGate decides
    // PG-pass-through vs mollify. Skipped for triggerAndWait
    // (resumeParentOnCompletion) — that path bypasses the gate via F4
    // and its existing PG-side dedup is sufficient.
    if (!request.body.options?.resumeParentOnCompletion) {
      const ttlSeconds = Math.max(
        1,
        Math.min(
          30,
          Math.ceil((idempotencyKeyExpiresAt.getTime() - Date.now()) / 1000),
        ),
      );
      const outcome = await claimOrAwait({
        envId: request.environment.id,
        taskIdentifier: request.taskId,
        idempotencyKey,
        ttlSeconds,
      });
      if (outcome.kind === "resolved") {
        // Another concurrent trigger committed first. Re-resolve via the
        // existing checks: writer-side PG findFirst first (defeats
        // replica lag), then buffer fallback for the buffered case.
        const writerRun = await this.prisma.taskRun.findFirst({
          where: {
            runtimeEnvironmentId: request.environment.id,
            idempotencyKey,
            taskIdentifier: request.taskId,
          },
          include: { associatedWaitpoint: true },
        });
        if (writerRun) {
          return { isCached: true, run: writerRun };
        }
        const buffered = await this.findBufferedRunWithIdempotency(
          request.environment.id,
          request.environment.organizationId,
          request.taskId,
          idempotencyKey,
        );
        if (buffered) {
          return { isCached: true, run: buffered };
        }
        // Claim resolved to a runId nothing can find — likely the
        // claimant errored after publish, or the row TTL'd out. Log
        // and fall through to a fresh trigger.
        logger.warn("idempotency claim resolved but runId not findable", {
          envId: request.environment.id,
          taskIdentifier: request.taskId,
          claimedRunId: outcome.runId,
        });
      }
      if (outcome.kind === "timed_out") {
        throw new ServiceValidationError(
          "Idempotency claim resolution timed out",
          503,
        );
      }
      if (outcome.kind === "claimed") {
        // Caller MUST publish/release. Signalled via the result's
        // `claim` field.
        return {
          isCached: false,
          idempotencyKey,
          idempotencyKeyExpiresAt,
          claim: {
            envId: request.environment.id,
            taskIdentifier: request.taskId,
            idempotencyKey,
          },
        };
      }
    }

    return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
  }
}
