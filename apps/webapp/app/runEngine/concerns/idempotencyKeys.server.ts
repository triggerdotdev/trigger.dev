import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";
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
import { shouldUseV2RunTable } from "~/v3/runTableV2.server";
import type { TraceEventConcern, TriggerTaskRequest } from "../types";

// In-memory per-org mollifier-enabled check, shared with `evaluateGate`
// (same `Organization.featureFlags` JSON, no DB read). Used to gate the
// pre-gate claim's Redis round-trip so non-mollifier orgs don't pay it
// during staged rollout — see the comment above the claim block in
// handleTriggerRequest.
const resolveOrgMollifierFlag = makeResolveMollifierFlag();

// Reserved task slot for the cross-table one-time-use-token claim. The DB
// constraint `@@unique([oneTimeUseToken])` is TASK-INDEPENDENT, so the claim
// must be keyed on the token alone, not (task, token): a single token can
// authorise more than one task, and two presentations for different tasks
// straddling a `runTableV2` flip would otherwise build different claim keys and
// both proceed. Folding the token into one constant task slot makes the claim
// key (envId, token)-scoped, matching the DB constraint's scope. Paired with
// the `otu:` idempotencyKey prefix, collision with a real task's idempotency
// claim would require a task literally named this AND an idempotency key of the
// form `otu:<token-hash>`.
const ONE_TIME_USE_TOKEN_CLAIM_TASK = "__one_time_use_token__";

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
    if (
      synthetic.idempotencyKeyExpiresAt &&
      synthetic.idempotencyKeyExpiresAt < new Date()
    ) {
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

  // Return an already-resolved idempotent run as a cache hit, blocking the
  // parent on the run's waitpoint when this is a triggerAndWait
  // (`resumeParentOnCompletion`). Shared by the direct PG/buffer existing-run
  // path and the claim-`resolved` path (a concurrent same-key trigger that won
  // the claim): a v2-cutover triggerAndWait that loses the claim must still
  // block its parent, because the per-table unique constraints don't dedup
  // across TaskRun/task_run_v2 — the claim is what serialises these.
  private async returnCachedIdempotentRun(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    existingRun: Prisma.TaskRunGetPayload<{ include: { associatedWaitpoint: true } }>,
    idempotencyKey: string
  ): Promise<IdempotencyKeyConcernResult> {
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
      // A one-time-use token with NO idempotency key would otherwise skip the
      // claim path below entirely. During a `runTableV2` flag flip, two
      // concurrent presentations of the same token can mint into DIFFERENT
      // physical tables (cuid -> TaskRun, ksuid -> task_run_v2); the per-table
      // unique constraint on `oneTimeUseToken` can't see across the two tables,
      // so neither INSERT raises P2002 and one token spawns two runs. For
      // v2-cutover orgs, serialise on the token via a Redis claim so the first
      // presentation wins and the rest are rejected as already-used. Not
      // excluded for resumeParentOnCompletion: for v2 orgs the idempotency-keyed
      // claim covers triggerAndWait too (claimEligible short-circuits on
      // shouldUseV2RunTable), so the token claim is consistent in doing the same;
      // the loser is rejected (not returned a cached run), so there is no
      // waitpoint-blocking subtlety to avoid.
      const oneTimeUseToken = request.options?.oneTimeUseToken;
      if (oneTimeUseToken) {
        const orgFeatureFlags =
          (request.environment.organization?.featureFlags as
            | Record<string, unknown>
            | null
            | undefined) ?? null;
        if (
          shouldUseV2RunTable(orgFeatureFlags, {
            nativeRealtimeEnabled: env.REALTIME_BACKEND_NATIVE_ENABLED === "1",
          })
        ) {
          // Key the claim on (envId, token), task-independent, to match the DB's
          // task-independent oneTimeUseToken constraint (see the constant's
          // comment). The TTL is a fixed pipeline-dwell bound, NOT the customer
          // idempotencyKeyTTL: there is no idempotency key in this path, so a
          // client-supplied TTL has no meaning here, and a tiny value would
          // expire the claim mid-flight and reopen the cross-table dup window.
          const claimKey = `otu:${oneTimeUseToken}`;
          const outcome = await claimOrAwait({
            envId: request.environment.id,
            taskIdentifier: ONE_TIME_USE_TOKEN_CLAIM_TASK,
            idempotencyKey: claimKey,
            ttlSeconds: env.TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS,
            safetyNetMs: env.TRIGGER_MOLLIFIER_CLAIM_WAIT_MS,
            pollStepMs: env.TRIGGER_MOLLIFIER_CLAIM_POLL_MS,
          });
          if (outcome.kind === "resolved") {
            // A concurrent presentation of the same one-time token already won
            // and committed a run. Reject this one exactly as the within-table
            // path does (the per-table oneTimeUseToken unique constraint raises
            // P2002 -> RunOneTimeUseTokenError -> this same 4xx), preserving the
            // "token already used" contract while closing the cross-table gap.
            throw new ServiceValidationError(
              `Cannot trigger ${request.taskId} with a one-time use token as it has already been used.`
            );
          } else if (outcome.kind === "timed_out") {
            throw new ServiceValidationError(
              "One-time-use token claim resolution timed out",
              503
            );
          } else if (outcome.kind === "claimed") {
            // We own the claim. The trigger pipeline MUST publish (on success)
            // or release (on error) it — wired through the returned `claim`,
            // exactly like the idempotency-keyed path.
            return {
              isCached: false,
              idempotencyKey,
              idempotencyKeyExpiresAt,
              claim: {
                envId: request.environment.id,
                taskIdentifier: ONE_TIME_USE_TOKEN_CLAIM_TASK,
                idempotencyKey: claimKey,
                token: outcome.token,
              },
            };
          }
        }
      }
      return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
    }

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
          this.prisma
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
        await runStore.clearIdempotencyKey(
          { byId: { runId: existingRun.id, idempotencyKey } },
          this.prisma
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
          this.prisma
        );

        return { isCached: false, idempotencyKey, idempotencyKeyExpiresAt };
      }

      // We have an idempotent run, so we return it (blocking the parent on its
      // waitpoint for triggerAndWait).
      return this.returnCachedIdempotentRun(request, parentStore, existingRun, idempotencyKey);
    }

    // Pre-gate claim — closes the PG+buffer race during gate transition.
    // All same-key triggers serialise here before evaluateGate decides
    // PG-pass-through vs mollify. For mollifier-only orgs this is skipped for
    // triggerAndWait (resumeParentOnCompletion) — that path bypasses the gate
    // and its PG-side dedup is sufficient there. v2-cutover orgs do NOT skip it
    // (see the claimEligible comment below): cross-table dedup has no shared
    // unique constraint, so the claim must cover triggerAndWait too.
    //
    // Also gated on the same per-org mollifier flag the gate uses: when
    // `TRIGGER_MOLLIFIER_ENABLED=1` globally for staged rollout, the buffer
    // singleton is constructed and `claimOrAwait` would otherwise issue a
    // Redis SETNX for EVERY idempotency-keyed trigger — including orgs
    // that haven't opted in. Those orgs never enter the mollify branch
    // (the gate always returns pass_through for them), so there's no
    // buffer activity to serialise against; PG's unique constraint
    // already deduplicates concurrent same-key races. Resolving the org
    // flag is a pure in-memory read of `Organization.featureFlags` — no
    // DB query, same predicate the gate uses — keeping the claim's Redis
    // RTT off the hot path for non-opted-in orgs during incremental
    // rollout.
    // Match the gate's bypass list (`mollifierGate.server.ts:158-175`).
    // debounce + oneTimeUseToken triggers always return pass_through from
    // the gate, so claiming a Redis SETNX here is wasted RTT on the
    // trigger hot path. Excluding them keeps the claim aligned with the
    // gate — if the gate would never mollify the request, there's no
    // buffer to serialise against.
    // Also serialise when the org is cut over to the v2 run table, even if it
    // isn't on the mollifier. Concurrent same-key triggers that straddle a
    // `runTableV2` flag flip can mint into DIFFERENT physical tables (cuid ->
    // TaskRun, ksuid -> task_run_v2); the per-table idempotency unique
    // constraints can't see each other, so neither INSERT raises P2002 and two
    // runs share one key. The Redis claim is the only backstop in that window.
    const orgFeatureFlags =
      (request.environment.organization?.featureFlags as
        | Record<string, unknown>
        | null
        | undefined) ?? null;
    // v2-cutover orgs: an idempotency-keyed trigger can straddle a `runTableV2`
    // flag flip into different physical tables (cuid -> TaskRun, ksuid ->
    // task_run_v2), and the per-table idempotency-key unique constraints can't
    // see across the two tables, so this claim (keyed on the idempotency key)
    // is the only backstop that serialises same-key triggers across the flip,
    // including triggerAndWait (resumeParentOnCompletion) and debounce. The
    // resumeParentOnCompletion/debounce/oneTimeUseToken exclusions below are
    // mollifier-gate alignment optimisations (those requests always return
    // pass_through from the gate, so there's no buffer to serialise against);
    // they don't apply to v2 orgs, which short-circuit to claimEligible via
    // shouldUseV2RunTable regardless. oneTimeUseToken triggers with NO
    // idempotency key are serialised separately by the token claim in the
    // early-return block above; the residual same-token-with-two-different-keys
    // case is not covered here (each key claims its own slot) and would require
    // a pathological client. shouldUseV2RunTable is checked first so a v2 org
    // skips the mollifier-flag resolve entirely.
    const claimEligible =
      shouldUseV2RunTable(orgFeatureFlags, {
        nativeRealtimeEnabled: env.REALTIME_BACKEND_NATIVE_ENABLED === "1",
      }) ||
      (!request.body.options?.resumeParentOnCompletion &&
        !request.body.options?.debounce &&
        !request.options?.oneTimeUseToken &&
        (await resolveOrgMollifierFlag({
          envId: request.environment.id,
          orgId: request.environment.organizationId,
          taskId: request.taskId,
          orgFeatureFlags,
        })));
    if (claimEligible) {
      const ttlSeconds = Math.max(
        1,
        Math.min(
          env.TRIGGER_MOLLIFIER_CLAIM_TTL_SECONDS,
          Math.ceil((idempotencyKeyExpiresAt.getTime() - Date.now()) / 1000),
        ),
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
          this.prisma
        );
        if (writerRun) {
          // The concurrent winner already committed. Return it as a cache hit,
          // and for triggerAndWait block our parent on the winner's waitpoint
          // (the claim is what serialises v2 cross-table triggerAndWait).
          return this.returnCachedIdempotentRun(
            request,
            parentStore,
            writerRun,
            idempotencyKey
          );
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
        // Claim resolved to a runId nothing can find — the run was
        // genuinely lost (claimant errored after publish, drain failed,
        // or both the PG row and buffer entry TTL'd out). This is
        // terminal, not transient: `lookupIdempotency` self-heals a
        // dangling pointer, and `ack` keeps the entry hash as a
        // read-fallback past the PG write, so re-polling cannot conjure
        // a run that is gone. Falling through to a fresh trigger is the
        // correct recovery.
        //
        // Why falling through claimless is safe (no duplicate runs):
        // concurrent triggers that also fall through here converge on a
        // single run via the same dedup backstops the claim layer relies
        // on — the PG unique constraint on the idempotency key
        // (RunDuplicateIdempotencyKeyError → retry resolves to the
        // winner) for the pass-through path, and `accept`'s idempotency
        // SETNX (`duplicate_idempotency`) for the mollify path. Once the
        // first fall-through commits a run, later callers find it via the
        // writer-PG / buffer lookups above despite the stale `resolved:`
        // slot, which the slot's TTL clears within ~30s. The residual
        // cost is a few redundant (deduped) trigger attempts in that
        // window, not duplicate runs.
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
