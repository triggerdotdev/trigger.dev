import { ownerEngine, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction, TaskRun, Waitpoint } from "@trigger.dev/database";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { RunEngine } from "~/v3/runEngine.server";
import { shouldIdempotencyKeyBeCleared } from "~/v3/taskStatus";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { claimOrAwait, resetResolvedClaim } from "~/v3/mollifier/idempotencyClaim.server";
import { computeClaimTtlSeconds } from "~/v3/mollifier/claimTtl";
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

// Cap on the claim-loser recreate re-acquisition loop (see
// reacquireClearedGlobalWinner). Each pass reopens a stale resolved slot and
// re-enters the claim; bounded so a pathological stream of expired/failed
// winners can't spin forever. On exhaustion we fall open to the create with
// PG's unique index as the backstop.
const MAX_CLEARED_WINNER_REACQUIRES = 5;

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

    // `global`-scope (or scope-absent) keys under the split have no per-run salt, so the Redis claim is
    // their only cross-DB dedup mutex. Computed here (not just in the claim block below) because the
    // expired/failed clear-and-recreate path must serialise through it too.
    const idempotencyKeyScope = request.body.options?.idempotencyKeyOptions?.scope;
    const globalUnderSplit =
      (idempotencyKeyScope === "global" || idempotencyKeyScope === undefined) &&
      (await isSplitEnabled());

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
      const handled = await this.handleExistingRun(request, parentStore, existingRun, {
        idempotencyKey,
        idempotencyKeyExpiresAt,
        dedupClient,
      });
      // A LIVE cached hit (or andWait waitpoint wiring) is terminal.
      if (handled.isCached) {
        return handled;
      }
      // isCached === false → the existing run was EXPIRED/FAILED, so handleExistingRun cleared its key
      // and we must recreate. For a global-scope key under split that recreate has to be claim-
      // serialised too — otherwise two concurrent cross-residency recreates each create a run the
      // per-DB unique index can't dedup (the same hole reacquireClearedGlobalWinner closes on the
      // claim-loser path). Non-split / non-global: the plain unserialised recreate is safe.
      if (globalUnderSplit) {
        return await this.reacquireClearedGlobalWinner(request, parentStore, {
          idempotencyKey,
          idempotencyKeyExpiresAt,
          dedupClient,
          ttlSeconds: computeClaimTtlSeconds({
            keyExpiresAt: idempotencyKeyExpiresAt,
            now: Date.now(),
            minTtlSeconds: env.TRIGGER_MOLLIFIER_CLAIM_MIN_TTL_SECONDS,
            maxTtlSeconds: env.TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS,
          }),
          clearedRunId: existingRun.friendlyId,
          safetyNetMs: env.TRIGGER_MOLLIFIER_CLAIM_WAIT_MS,
          pollStepMs: env.TRIGGER_MOLLIFIER_CLAIM_POLL_MS,
        });
      }
      return handled;
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
    //
    // Under the run-ops split the claim ALSO acts as the only cross-DB mutex a
    // `global`-scope key has: that key is per (environment, task), so it can be
    // triggered concurrently from two parents on DIFFERENT physical DBs where
    // each probe misses and the per-DB unique index can't enforce uniqueness.
    // For that case the claim is eligible regardless of the per-org flag AND of
    // resumeParentOnCompletion (the loser wires its parent waitpoint against the
    // winner in the resolved branch below). An absent scope (pre-hashed key /
    // older SDK) is treated conservatively as possibly-global — harmless for a
    // real run/attempt key, whose hash already embeds the parent id so two
    // parents mint DISTINCT keys that never share a claim slot.
    // (idempotencyKeyScope / globalUnderSplit are computed above — they also gate the expired/failed
    // recreate serialisation.)
    const claimEligible =
      !request.body.options?.debounce &&
      !request.options?.oneTimeUseToken &&
      (globalUnderSplit ||
        (!request.body.options?.resumeParentOnCompletion &&
          (await resolveOrgMollifierFlag({
            envId: request.environment.id,
            orgId: request.environment.organizationId,
            taskId: request.taskId,
            orgFeatureFlags:
              (request.environment.organization?.featureFlags as
                | Record<string, unknown>
                | null
                | undefined) ?? null,
          }))));
    if (claimEligible) {
      const ttlSeconds = computeClaimTtlSeconds({
        keyExpiresAt: idempotencyKeyExpiresAt,
        now: Date.now(),
        minTtlSeconds: env.TRIGGER_MOLLIFIER_CLAIM_MIN_TTL_SECONDS,
        maxTtlSeconds: env.TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS,
      });
      const outcome = await claimOrAwait({
        envId: request.environment.id,
        taskIdentifier: request.taskId,
        idempotencyKey,
        ttlSeconds,
        safetyNetMs: env.TRIGGER_MOLLIFIER_CLAIM_WAIT_MS,
        pollStepMs: env.TRIGGER_MOLLIFIER_CLAIM_POLL_MS,
      });
      if (outcome.kind === "resolved") {
        // Global-under-split loser: the winner lives on ITS parent's DB, which
        // may differ from this loser's parent DB. Resolve the winner by id
        // across both DBs (classify the winner friendlyId → NEW/LEGACY client,
        // then let the router route+fall-back by id-shape) and feed it through
        // the same existing-run handling the PG-hit path uses — so expiry-clear,
        // status-clear, and the resumeParentOnCompletion waitpoint wiring all
        // apply to the loser exactly as they would to a plain cached hit.
        if (globalUnderSplit) {
          const winner = await this.resolveWinnerAcrossDbs(outcome.runId, request.environment.id);
          if (winner) {
            const resolved = await this.handleExistingRun(request, parentStore, winner, {
              idempotencyKey,
              idempotencyKeyExpiresAt,
              dedupClient,
            });
            // A LIVE winner (cached hit, or andWait waitpoint wired) is terminal.
            if (resolved.isCached) {
              return resolved;
            }
            // CRITICAL (CodeRabbit): the resolved winner was EXPIRED or FAILED, so
            // handleExistingRun cleared its key and would have us CREATE a new run.
            // The initial create is serialised by the claim, but this clear-and-
            // recreate is not — and under the split the per-DB unique index can't
            // dedup a cross-residency recreate, so two concurrent losers clearing
            // the SAME winner would each create → duplicate run. Re-serialise the
            // recreate through the claim so exactly one caller recreates (and
            // publishes) while the rest resolve to the fresh run.
            return await this.reacquireClearedGlobalWinner(request, parentStore, {
              idempotencyKey,
              idempotencyKeyExpiresAt,
              dedupClient,
              ttlSeconds,
              clearedRunId: outcome.runId,
              safetyNetMs: env.TRIGGER_MOLLIFIER_CLAIM_WAIT_MS,
              pollStepMs: env.TRIGGER_MOLLIFIER_CLAIM_POLL_MS,
            });
          }
        }
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

  // Resolve an already-existing idempotent run: honour key expiry / status
  // clearing, and for `andWait` (resumeParentOnCompletion) block the calling
  // parent on the run's waitpoint. Extracted so both the PG-hit path and the
  // cross-DB claim-loser path resolve an existing run identically.
  private async handleExistingRun(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    existingRun: TaskRun & { associatedWaitpoint?: Waitpoint | null },
    ctx: {
      idempotencyKey: string;
      idempotencyKeyExpiresAt: Date;
      dedupClient: PrismaClientOrTransaction;
    }
  ): Promise<IdempotencyKeyConcernResult> {
    const { idempotencyKey, idempotencyKeyExpiresAt, dedupClient } = ctx;

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

  // Re-serialise a cross-DB recreate through the claim after a claim-loser's
  // resolved winner turned out to be EXPIRED / FAILED (its key was cleared by
  // handleExistingRun). Without this, concurrent losers clearing the same
  // winner each create a new run on their own DB — the per-DB unique index
  // can't dedup a cross-residency pair, so the initial-create's serialisation
  // is lost on the recreate. Each pass: compare-and-delete the stale resolved
  // slot (keyed on the cleared runId — never an unconditional DEL, so a
  // reacquirer that already re-published a NEW winner is not wiped), then
  // re-enter claimOrAwait. Exactly one caller wins the re-claim and recreates
  // (returning its claim to publish); the rest resolve to the fresh run. If a
  // re-claim resolves to ANOTHER cleared winner we advance and loop, bounded
  // by MAX_CLEARED_WINNER_REACQUIRES; on exhaustion (or an unfindable
  // resolution) we fail CLOSED with a retryable 503 so the SDK retry re-serialises,
  // rather than fall open to an unserialised cross-DB create.
  private async reacquireClearedGlobalWinner(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    ctx: {
      idempotencyKey: string;
      idempotencyKeyExpiresAt: Date;
      dedupClient: PrismaClientOrTransaction;
      ttlSeconds: number;
      clearedRunId: string;
      safetyNetMs: number;
      pollStepMs: number;
    }
  ): Promise<IdempotencyKeyConcernResult> {
    const { idempotencyKey, idempotencyKeyExpiresAt, dedupClient, ttlSeconds } = ctx;
    const claimInput = {
      envId: request.environment.id,
      taskIdentifier: request.taskId,
      idempotencyKey,
    };
    let staleRunId = ctx.clearedRunId;
    for (let attempt = 0; attempt < MAX_CLEARED_WINNER_REACQUIRES; attempt++) {
      await resetResolvedClaim({ ...claimInput, runId: staleRunId });

      const outcome = await claimOrAwait({
        ...claimInput,
        ttlSeconds,
        safetyNetMs: ctx.safetyNetMs,
        pollStepMs: ctx.pollStepMs,
      });

      if (outcome.kind === "timed_out") {
        throw new ServiceValidationError("Idempotency claim resolution timed out", 503);
      }
      if (outcome.kind === "claimed") {
        // We own the recreate. Caller MUST publish the new runId / release on error.
        return {
          isCached: false,
          idempotencyKey,
          idempotencyKeyExpiresAt,
          claim: { ...claimInput, token: outcome.token },
        };
      }
      // resolved: another caller won the recreate. Honour it like any cached
      // hit (incl. andWait wiring). If it too was cleared, advance and loop.
      const winner = await this.resolveWinnerAcrossDbs(outcome.runId, request.environment.id);
      if (!winner) {
        logger.warn("idempotency reacquire resolved but runId not findable", {
          envId: request.environment.id,
          taskIdentifier: request.taskId,
          claimedRunId: outcome.runId,
        });
        break;
      }
      const resolved = await this.handleExistingRun(request, parentStore, winner, {
        idempotencyKey,
        idempotencyKeyExpiresAt,
        dedupClient,
      });
      if (resolved.isCached) {
        return resolved;
      }
      staleRunId = outcome.runId;
    }
    // Exhausted the bounded reacquires (or the winner was unfindable). Rather than fall through to an
    // UNSERIALISED create — which under global-scope-split can dual-create across DBs (the per-DB unique
    // index can't dedup cross-residency) — fail closed with a retryable 503 so the SDK retry re-serialises
    // through a fresh claim (mirrors the timed_out branch above).
    throw new ServiceValidationError(
      "Idempotency claim could not be re-serialised after repeated cleared winners",
      503
    );
  }

  // Resolve a claim winner (a run friendlyId) across both split DBs. Classify
  // the id-shape to pick the writer client for read-your-writes, then read by
  // id — the routing store routes to the owning store and falls back to the
  // other, so a winner on either DB is found. Returns null when the id can't be
  // classified or the row genuinely isn't there (caller falls through).
  private async resolveWinnerAcrossDbs(
    winnerFriendlyId: string,
    environmentId: string
  ): Promise<(TaskRun & { associatedWaitpoint?: Waitpoint | null }) | null> {
    let internalId: string;
    try {
      internalId = RunId.fromFriendlyId(winnerFriendlyId);
    } catch {
      return null;
    }
    let client: PrismaClientOrTransaction;
    try {
      client = ownerEngine(internalId) === "NEW" ? runOpsNewPrisma : runOpsLegacyPrisma;
    } catch {
      client = this.prisma;
    }
    return runStore.findRun(
      { id: internalId, runtimeEnvironmentId: environmentId },
      { include: { associatedWaitpoint: true } },
      client
    );
  }
}
