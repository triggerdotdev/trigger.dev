import { randomUUID } from "node:crypto";
import type {
  IdempotencyClaimResult,
  IdempotencyLookupInput,
  MollifierBuffer,
} from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { getIdempotencyClaimBuffer } from "./mollifierBuffer.server";

// Tunables. The TTL on the claim key is bounded by typical trigger-pipeline
// dwell; long enough that a slow PG insert doesn't expire mid-flight,
// short enough that a crashed claimant unblocks waiters quickly.
export const DEFAULT_CLAIM_TTL_SECONDS = 30;
// safetyNetMs caps how long a waiter blocks before returning timed_out.
// Matches the mutateWithFallback safety net so SDK retry policies don't
// have to special-case this path.
export const DEFAULT_CLAIM_WAIT_MS = 5_000;
export const DEFAULT_CLAIM_POLL_MS = 25;

export type ClaimOrAwaitOutcome =
  // We own the claim. `token` MUST be passed to publishClaim/releaseClaim
  // so the buffer can compare-and-act against our ownership marker — a
  // late release from a previous claimant whose TTL expired cannot
  // erase our slot.
  | { kind: "claimed"; token: string }
  | { kind: "resolved"; runId: string } // someone else's runId; caller returns isCached:true
  | { kind: "timed_out" };

export type ClaimOrAwaitInput = IdempotencyLookupInput & {
  ttlSeconds?: number;
  safetyNetMs?: number;
  pollStepMs?: number;
  abortSignal?: AbortSignal;
  // Test injection.
  buffer?: MollifierBuffer | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // Test override for the ownership-token generator. Defaults to
  // `crypto.randomUUID()`. Tests pass a deterministic value so they
  // can assert publish/release pass-through.
  generateToken?: () => string;
};

// Pre-gate Redis claim. All same-key triggers serialise through here
// before the trigger pipeline runs. Returning `resolved` short-circuits
// the trigger entirely — the caller responds with the cached runId.
// Returning `claimed` means we own the claim and MUST publish the
// winning runId on success (`publishClaim`) or release the claim on
// failure (`releaseClaim`).
//
// Failure modes:
// - Redis down at claim time: returns `claimed` (fail open, no
//   coordination). Customer is no worse than today's race; the
//   PG unique constraint is the eventual arbiter.
// - Claimant crashes mid-pipeline: claim TTL expires, waiters
//   eventually time out, SDK retries.
// - PG/buffer publish failure: waiters time out and SDK retries; next
//   attempt sees the eventual PG/buffer state via existing
//   IdempotencyKeyConcern PG-first lookup.
export async function claimOrAwait(input: ClaimOrAwaitInput): Promise<ClaimOrAwaitOutcome> {
  const buffer = input.buffer === undefined ? getIdempotencyClaimBuffer() : input.buffer;
  if (!buffer) {
    // No claim backend at all — both the mollifier buffer and the
    // standalone claim buffer are unavailable (the general Redis host is
    // unconfigured). Fall open: the caller proceeds with the trigger
    // pipeline (PG unique constraint backstop). The token is never read in
    // this case (publish/release are buffer-null no-ops downstream), so we
    // skip the default `randomUUID()` to keep this hot path allocation-free
    // for idempotency-keyed triggers — `triggerTask` is the
    // highest-throughput code path in the system. A test-injected
    // generator is still honoured for deterministic assertions.
    return { kind: "claimed", token: input.generateToken ? input.generateToken() : "" };
  }
  const generateToken = input.generateToken ?? randomUUID;
  // Generate the ownership token up front so the retry loop reuses it
  // — we're the same logical claimant across attempts; only the slot
  // owner changes between releases.
  const token = generateToken();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
  const safetyNetMs = input.safetyNetMs ?? DEFAULT_CLAIM_WAIT_MS;
  const pollStepMs = input.pollStepMs ?? DEFAULT_CLAIM_POLL_MS;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;

  const lookupInput: IdempotencyLookupInput = {
    envId: input.envId,
    taskIdentifier: input.taskIdentifier,
    idempotencyKey: input.idempotencyKey,
  };

  // Initial claim attempt. Most production-path calls resolve here on
  // the first call (either we win, or the key is already resolved from
  // a prior burst).
  let result: IdempotencyClaimResult;
  try {
    result = await buffer.claimIdempotency({ ...lookupInput, token, ttlSeconds });
  } catch (err) {
    logger.warn("idempotency claim failed (fail-open)", {
      envId: input.envId,
      taskIdentifier: input.taskIdentifier,
      err: err instanceof Error ? err.message : String(err),
    });
    return { kind: "claimed", token };
  }

  if (result.kind === "claimed") return { kind: "claimed", token };
  if (result.kind === "resolved") return result;

  // result.kind === "pending" — wait/poll loop. May see the value flip
  // to "resolved" (winner published), the key vanish (winner released
  // on error → retry claim), or stay "pending" until the safety net.
  const deadline = now() + safetyNetMs;
  while (now() < deadline) {
    if (input.abortSignal?.aborted) return { kind: "timed_out" };
    await sleep(pollStepMs);

    let current: IdempotencyClaimResult | null;
    try {
      current = await buffer.readClaim(lookupInput);
    } catch (err) {
      // Transient read failure — keep polling until deadline.
      logger.warn("idempotency claim read failed mid-poll", {
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (current === null) {
      // Claimant released on error. Re-attempt the claim — one of the
      // waiters will win, the rest see "pending" again. Reuse our token:
      // we're still the same logical claimant, just contending for a
      // freshly empty slot.
      try {
        const retry = await buffer.claimIdempotency({ ...lookupInput, token, ttlSeconds });
        if (retry.kind === "claimed") return { kind: "claimed", token };
        if (retry.kind === "resolved") return retry;
        // "pending" again → keep polling.
      } catch (err) {
        logger.warn("idempotency claim retry failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        return { kind: "claimed", token };
      }
      continue;
    }
    if (current.kind === "resolved") return current;
    // current.kind === "pending" → keep polling.
  }
  return { kind: "timed_out" };
}

// Publish the winning runId so waiters resolve. Best-effort: failure
// here means waiters will time out and the SDK will retry, which will
// then find the row via the existing IdempotencyKeyConcern PG-first
// check.
export async function publishClaim(input: {
  envId: string;
  taskIdentifier: string;
  idempotencyKey: string;
  // Ownership token from the `claimed` outcome. Buffer compare-and-sets
  // on this so a publish from a stale claimant (TTL expired, another
  // claimant moved in) is a no-op rather than overwriting their claim.
  token: string;
  runId: string;
  ttlSeconds?: number;
  buffer?: MollifierBuffer | null;
}): Promise<void> {
  const buffer = input.buffer === undefined ? getIdempotencyClaimBuffer() : input.buffer;
  if (!buffer) return;
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
  try {
    await buffer.publishClaim({
      envId: input.envId,
      taskIdentifier: input.taskIdentifier,
      idempotencyKey: input.idempotencyKey,
      token: input.token,
      runId: input.runId,
      ttlSeconds,
    });
  } catch (err) {
    logger.warn("idempotency claim publish failed", {
      envId: input.envId,
      taskIdentifier: input.taskIdentifier,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// Release on pipeline failure. Best-effort. If the DEL fails, the claim
// TTL is the safety net — waiters time out, SDK retries.
export async function releaseClaim(input: {
  envId: string;
  taskIdentifier: string;
  idempotencyKey: string;
  // Ownership token from the `claimed` outcome. Buffer compare-and-
  // deletes on this so a release from a stale claimant whose TTL
  // expired can't wipe a new owner's claim.
  token: string;
  buffer?: MollifierBuffer | null;
}): Promise<void> {
  const buffer = input.buffer === undefined ? getIdempotencyClaimBuffer() : input.buffer;
  if (!buffer) return;
  try {
    await buffer.releaseClaim({
      envId: input.envId,
      taskIdentifier: input.taskIdentifier,
      idempotencyKey: input.idempotencyKey,
      token: input.token,
    });
  } catch (err) {
    logger.warn("idempotency claim release failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
