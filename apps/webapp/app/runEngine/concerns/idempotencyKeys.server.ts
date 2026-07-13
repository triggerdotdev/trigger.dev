import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { RunEngine } from "~/v3/runEngine.server";
import { shouldIdempotencyKeyBeCleared } from "~/v3/taskStatus";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { claimOrAwait } from "~/v3/mollifier/idempotencyClaim.server";
import { makeResolveMollifierFlag } from "~/v3/mollifier/mollifierGate.server";
import { runStore } from "~/v3/runStore.server";
import { runOpsLegacyPrisma, runOpsNewPrisma } from "~/db.server";
import { isSplitEnabled } from "~/v3/runOpsMigration/splitMode.server";
import { resolveRunIdMintKind } from "~/v3/engineVersion.server";
import { resolveIdempotencyDedupClient } from "./idempotencyResidency.server";
import type { TraceEventConcern, TriggerTaskRequest } from "../types";

// In-memory per-org mollifier-enabled check, shared with `evaluateGate`
// (same `Organization.featureFlags` JSON, no DB read). Used to gate the
// pre-gate claim's Redis round-trip so non-mollifier orgs don't pay it
// during staged rollout — see the comment above the claim block in
// handleTriggerRequest.
const resolveOrgMollifierFlag = makeResolveMollifierFlag();

// Claim ownership context returned to the caller when the
// IdempotencyKeyConcern won a pre-gate claim. Caller MUST publish the
// winning runId on pipeline success (`publishClaim`) or release the
// claim on failure (`releaseClaim`).
export type ClaimedIdempotency = {
  envId: string;
  taskIdentifier: string;
  idempotencyKey: string;
  // Ownership token from `claimOrAwait`. The caller's trigger pipeline
  // MUST thread this into publishClaim/releaseClaim so the buffer's
  // compare-and-act protects the slot against a stale predecessor.
  token: string;
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

  // Buffer-side idempotency dedup. Resolves an idempotency key against the
  // mollifier buffer when PG missed. Returns a SyntheticRun cast to
  // TaskRun so the route handler (which only reads run.id / run.friendlyId)
  // can echo the buffered run's friendlyId as a cached hit. Returns null
  // for any failure or miss — buffer outages must not 500 the trigger
  // hot path; we fail open to "no cache hit" and let the request through.
  private async findBufferedRunWithIdempotency(
    environmentId: string,
    organizationId: string,
    taskIdentifier: string,
    idempotencyKey: string
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
    // PG-resident path enforces idempotency-key expiry below
    // (`existingRun.idempotencyKeyExpiresAt < new Date()` clears the key
    // and lets a new run go through). The buffer path needs the same
    // check — without it a customer who passes `idempotencyKeyTTL: "2s"`
    // gets the cached buffered runId returned indefinitely, because the
    // buffer entry persists for its own (hours-long) TTL independent of
    // the customer's key TTL.
    //
    // Returning null isn't enough on its own: the trigger pipeline then
    // proceeds to `mollifyTrigger`, whose `buffer.accept` Lua dedupes by
    // `(envId, taskIdentifier, idempotencyKey)` via SETNX on the same
    // `mollifier:idempotency:*` key and would echo the stale runId as
    // `duplicate_idempotency`. Clear the buffer-side idempotency
    // binding (both the lookup and any in-flight claim) so the next
    // accept goes through as a fresh trigger. Mirrors what
    // `ResetIdempotencyKeyService` does for the explicit
    // reset-via-API path.
    if (synthetic.idempotencyKeyExpiresAt && synthetic.idempotencyKeyExpiresAt < new Date()) {
      const buffer = getMollifierBuffer();
      if (buffer) {
        try {
          await buffer.resetIdempotency({
            envId: environmentId,
            taskIdentifier,
            idempotencyKey,
          });
        } catch (err) {
          logger.warn("IdempotencyKeyConcern: failed to reset expired buffer idempotency", {
            envId: environmentId,
            taskIdentifier,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return null;
    }
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

    // Probe and clears must hit the DB where the would-be run will physically live.
    const dedupClient = await resolveIdempotencyDedupClient(
      {
        environmentForMint: {
          organizationId: request.environment.organizationId,
          id: request.environment.id,
          orgFeatureFlags: request.environment.organization?.featureFlags,
        },
        parentRunFriendlyId: request.body.options?.parentRunId,
      },
      {
        isSplitEnabled,
        fallbackClient: this.prisma,
        newClient: runOpsNewPrisma,
        legacyClient: runOpsLegacyPrisma,
        resolveMintKind: resolveRunIdMintKind,
        // `isMigrated` is intentionally omitted: until a child of a swept
        // legacy-id parent can be born on the new DB, the swept-marker override
        // would never change the answer, so a child routes by parent id-shape.
      }
    );

    const existingRun = idempotencyKey
      ? await runStore.findRun(
          {
            runtimeEnvironmentId: request.environment.id,
            idempotencyKey,
            taskIdentifier: request.taskId,
          },
          {
            include: {
              associatedWaitpoint: true,
            },
          },
          dedupClient
        )
      : undefined;

    // Buffer fallback per the mollifier-idempotency design. PG missed —
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
        idempotencyKey
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
        await runStore.clearIdempotencyKey(
          { byId: { runId: existingRun.id, idempotencyKey } },
          dedupClient
        );

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
        await runStore.clearIdempotencyKey(
          { byId: { runId: existingRun.id, idempotencyKey } },
          dedupClient
        );

        return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
      }

      // We have an idempotent run, so we return it
      const parentRunId = request.body.options?.parentRunId;
      const resumeParentOnCompletion = request.body.options?.resumeParentOnCompletion;

      //We're using `andWait` so we need to block the parent run with a waitpoint
      if (resumeParentOnCompletion && parentRunId) {
        // `parentRunId` comes from the request body and isn't re-validated
        // here, so confirm the parent run is in the caller's environment
        // before wiring a waitpoint against it.
        const parentRunInternalId = RunId.fromFriendlyId(parentRunId);
        const parentRunInCallerEnv = await runStore.findRun(
          {
            id: parentRunInternalId,
            runtimeEnvironmentId: request.environment.id,
          },
          { select: { id: true } },
          this.prisma
        );
        if (!parentRunInCallerEnv) {
          throw new ServiceValidationError("Parent run not found in the calling environment", 404);
        }

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

            await this.engine.blockRunWithWaitpoint({
              runId: parentRunInternalId,
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
              tx: dedupClient,
            });
          }
        );
      }

      return { isCached: true, run: existingRun };
    }

    // Pre-gate claim — closes the PG+buffer race during gate transition.
    // All same-key triggers serialise here before evaluateGate decides
    // PG-pass-through vs mollify. Skipped for triggerAndWait
    // (resumeParentOnCompletion) — that path bypasses the gate entirely
    // and its existing PG-side dedup is sufficient.
    //
    // Gated on the same per-org mollifier flag the gate uses, and the same
    // bypass list (debounce + oneTimeUseToken): if the gate would never mollify
    // the request, there's no buffer to serialise against and PG's unique
    // constraint already deduplicates concurrent same-key races. Skipping the
    // claim's Redis SETNX keeps its RTT off the hot path for those requests
    // during staged rollout. The org-flag check is a pure in-memory read of
    // `Organization.featureFlags`, no DB query.
    const claimEligible =
      !request.body.options?.resumeParentOnCompletion &&
      !request.body.options?.debounce &&
      !request.options?.oneTimeUseToken &&
      (await resolveOrgMollifierFlag({
        envId: request.environment.id,
        orgId: request.environment.organizationId,
        taskId: request.taskId,
        orgFeatureFlags:
          (request.environment.organization?.featureFlags as
            | Record<string, unknown>
            | null
            | undefined) ?? null,
      }));
    if (claimEligible) {
      const ttlSeconds = Math.max(
        1,
        Math.min(
          env.TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS,
          Math.ceil((idempotencyKeyExpiresAt.getTime() - Date.now()) / 1000)
        )
      );
      const outcome = await claimOrAwait({
        envId: request.environment.id,
        taskIdentifier: request.taskId,
        idempotencyKey,
        ttlSeconds,
        safetyNetMs: env.TRIGGER_MOLLIFIER_CLAIM_WAIT_MS,
        pollStepMs: env.TRIGGER_MOLLIFIER_CLAIM_POLL_MS,
      });
      if (outcome.kind === "resolved") {
        // Another concurrent trigger committed first. Re-resolve via the
        // existing checks: writer-side PG findFirst first (defeats
        // replica lag), then buffer fallback for the buffered case.
        const writerRun = await runStore.findRun(
          {
            runtimeEnvironmentId: request.environment.id,
            idempotencyKey,
            taskIdentifier: request.taskId,
          },
          { include: { associatedWaitpoint: true } },
          dedupClient
        );
        if (writerRun) {
          return { isCached: true, run: writerRun };
        }
        const buffered = await this.findBufferedRunWithIdempotency(
          request.environment.id,
          request.environment.organizationId,
          request.taskId,
          idempotencyKey
        );
        if (buffered) {
          return { isCached: true, run: buffered };
        }
        // Claim resolved to a runId nothing can find — the run was genuinely
        // lost (claimant errored after publish, or both the PG row and buffer
        // entry TTL'd out). Terminal, not transient, so falling through to a
        // fresh trigger is the correct recovery.
        //
        // Falling through claimless doesn't duplicate runs: concurrent
        // fall-throughs converge on one run via the same dedup backstops the
        // claim layer relies on — PG's unique constraint on the idempotency key
        // (pass-through path) and `accept`'s SETNX (mollify path). Once the
        // first commits, later callers find it via the writer-PG / buffer
        // lookups above despite the stale `resolved:` slot (cleared by its ~30s
        // TTL). Residual cost is a few deduped trigger attempts, not dup runs.
        logger.warn("idempotency claim resolved but runId not findable", {
          envId: request.environment.id,
          taskIdentifier: request.taskId,
          claimedRunId: outcome.runId,
        });
      }
      if (outcome.kind === "timed_out") {
        throw new ServiceValidationError("Idempotency claim resolution timed out", 503);
      }
      if (outcome.kind === "claimed") {
        // Caller MUST publish/release. Signalled via the result's
        // `claim` field, including the ownership token so the buffer
        // can compare-and-act on the slot we now own.
        return {
          isCached: false,
          idempotencyKey,
          idempotencyKeyExpiresAt,
          claim: {
            envId: request.environment.id,
            taskIdentifier: request.taskId,
            idempotencyKey,
            token: outcome.token,
          },
        };
      }
    }

    return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
  }
}
