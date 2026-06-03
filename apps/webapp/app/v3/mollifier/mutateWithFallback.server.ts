import type {
  BufferEntry,
  MollifierBuffer,
  MutateSnapshotResult,
  SnapshotPatch,
} from "@trigger.dev/redis-worker";
import type { TaskRun } from "@trigger.dev/database";
import { prisma, $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

// Wait/retry knobs. Exported for tests.
export const DEFAULT_SAFETY_NET_MS = 2_000;
// Initial gap between buffer polls; grows by BACKOFF_FACTOR up to
// DEFAULT_MAX_POLL_STEP_MS so a slow drain doesn't poll at a tight fixed
// cadence for the whole safety-net budget.
export const DEFAULT_POLL_STEP_MS = 20;
export const DEFAULT_MAX_POLL_STEP_MS = 250;
const BACKOFF_FACTOR = 1.7;

export type MutateWithFallbackInput<TResponse> = {
  runId: string;
  environmentId: string;
  organizationId: string;
  bufferPatch: SnapshotPatch;
  // Called when a PG row exists (either replica-hit or post-wait writer-hit).
  // Receives the full TaskRun shape and returns the customer-visible body.
  pgMutation: (pgRow: TaskRun) => Promise<TResponse>;
  // Called when the patch landed cleanly on the buffer snapshot. The
  // drainer will see the patched payload on its next pop. Receives the
  // pre-mutation snapshot entry (the one fetched for the env auth
  // check above) so the caller can compute response details that
  // depend on the prior state — e.g. the tags route needs to dedup
  // against the existing tags to report an accurate `newTags` count
  // matching the PG path, without an extra Redis round-trip.
  // `bufferEntry` is `null` in the rare race where the entry didn't
  // exist at pre-check time but appeared before `mutateSnapshot`.
  synthesisedResponse: (ctx: {
    bufferEntry: BufferEntry | null;
  }) => TResponse | Promise<TResponse>;
  // Called when the buffer rejected the patch as invalid (e.g. an
  // `append_tags` patch carrying `maxTags` would exceed the cap). Required
  // only by callers that send a rejectable patch; the helper throws if the
  // buffer reports a rejection and no builder was supplied. Receives the
  // same `bufferEntry` context as `synthesisedResponse` so a rejection
  // message can reference the prior state if useful.
  rejectedResponse?: (ctx: {
    bufferEntry: BufferEntry | null;
  }) => TResponse | Promise<TResponse>;
  abortSignal?: AbortSignal;
  // Override defaults for tests.
  safetyNetMs?: number;
  pollStepMs?: number;
  maxPollStepMs?: number;
  // Test injection.
  getBuffer?: () => MollifierBuffer | null;
  prismaWriter?: TaskRunReader;
  prismaReplica?: TaskRunReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Jitter source; defaults to Math.random. Inject `() => 0` for
  // deterministic poll timing in tests.
  random?: () => number;
};

export type MutateWithFallbackOutcome<TResponse> =
  | { kind: "pg"; response: TResponse }
  | { kind: "snapshot"; response: TResponse }
  | { kind: "rejected"; response: TResponse }
  | { kind: "not_found" }
  | { kind: "timed_out" };

// PG-first → buffer mutateSnapshot → wait-and-bounce. The
// caller decides how to translate the outcome into an HTTP response —
// this helper never throws Response objects so it remains route-agnostic
// and unit-testable in isolation.
export async function mutateWithFallback<TResponse>(
  input: MutateWithFallbackInput<TResponse>,
): Promise<MutateWithFallbackOutcome<TResponse>> {
  const replica = input.prismaReplica ?? $replica;
  const writer = input.prismaWriter ?? prisma;
  const buffer = (input.getBuffer ?? getMollifierBuffer)();
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;

  // Path 1 — PG is already canonical.
  const replicaRow = await findRunInPg(replica, input.runId, input.environmentId);
  if (replicaRow) {
    const response = await input.pgMutation(replicaRow);
    return { kind: "pg", response };
  }

  if (!buffer) {
    // No buffer configured (mollifier disabled or boot-time error). The
    // pre-PR mutation routes read from the writer directly, so a freshly-
    // created PG row was always visible regardless of replication lag.
    // Now that the read moved to the replica (line 87) for the offload,
    // a `!buffer` short-circuit would regress: a real PG row + replica
    // lag would return 404. Mirror the writer-disambiguation block below
    // (line 148, the buffer-says-not-found path) so degraded mode
    // (mollifier disabled) still matches pre-PR mutation behaviour.
    const writerRow = await findRunInPg(writer, input.runId, input.environmentId);
    if (writerRow) {
      const response = await input.pgMutation(writerRow);
      return { kind: "pg", response };
    }
    return { kind: "not_found" };
  }

  // Env-scoped authorization for the buffer path. The replica/writer
  // lookups above are already env-scoped via findRunInPg; this closes
  // the same gap on the buffer side so a caller authed in env A can't
  // mutate a buffered run that belongs to env B (or a different org)
  // by guessing its friendlyId. Non-atomic w.r.t. the mutateSnapshot
  // call below, but the TOCTOU is benign: runIds are globally unique,
  // so a cross-env entry can't suddenly appear after a same-env check.
  // A genuinely-missing entry (entry === null) falls through and is
  // handled by the existing not_found / writer-recovery path below.
  const entryForAuth = await buffer.getEntry(input.runId);
  if (
    entryForAuth &&
    (entryForAuth.envId !== input.environmentId ||
      entryForAuth.orgId !== input.organizationId)
  ) {
    // Hide existence on env mismatch: return not_found, same shape as
    // a true miss, rather than 403 which would leak that the runId
    // exists in some other env.
    return { kind: "not_found" };
  }

  // Path 2 — buffer snapshot mutation.
  const result: MutateSnapshotResult = await buffer.mutateSnapshot(
    input.runId,
    input.bufferPatch,
  );

  if (result === "applied_to_snapshot") {
    return {
      kind: "snapshot",
      response: await input.synthesisedResponse({ bufferEntry: entryForAuth }),
    };
  }

  if (result === "limit_exceeded") {
    // The buffer refused the patch (e.g. tag cap). Nothing was written.
    // Surface the caller's rejection body; a missing builder means the
    // caller sent a rejectable patch without handling the rejection.
    if (!input.rejectedResponse) {
      throw new Error(
        "mutateWithFallback: buffer returned 'limit_exceeded' but no rejectedResponse was provided",
      );
    }
    return {
      kind: "rejected",
      response: await input.rejectedResponse({ bufferEntry: entryForAuth }),
    };
  }

  if (result === "not_found") {
    // Disambiguate a genuine 404 from a replica-lag miss: ask the writer
    // directly. If the row just appeared post-drain we route through the
    // PG mutation path.
    const writerRow = await findRunInPg(writer, input.runId, input.environmentId);
    if (writerRow) {
      const response = await input.pgMutation(writerRow);
      return { kind: "pg", response };
    }
    return { kind: "not_found" };
  }

  // result === "busy" — the entry is mid-handoff (DRAINING) or already
  // materialised. We do NOT poll the primary for the row to appear: that
  // piles read load onto the writer at exactly the moment mollifier exists
  // to shed it. Instead we watch the buffer entry itself (cheap Redis
  // reads). The drainer writes the PG row BEFORE it acks (sets
  // `materialised`) or fails (deletes the entry), so the entry's own state
  // is an authoritative, already-in-Redis signal for "is the row in PG
  // yet?". Only once it resolves do we touch the primary — exactly once,
  // for the real mutation.
  const safetyNetMs = input.safetyNetMs ?? DEFAULT_SAFETY_NET_MS;
  const maxPollStepMs = input.maxPollStepMs ?? DEFAULT_MAX_POLL_STEP_MS;
  const random = input.random ?? Math.random;
  const deadline = now() + safetyNetMs;
  let step = input.pollStepMs ?? DEFAULT_POLL_STEP_MS;

  while (now() < deadline) {
    if (input.abortSignal?.aborted) {
      return { kind: "timed_out" };
    }

    const entry = await buffer.getEntry(input.runId);
    // Resolved when the entry is gone (`fail` deleted it after writing a
    // terminal SYSTEM_FAILURE row) or materialised (`ack` after a
    // successful trigger / cancel write). In both cases the PG row is now
    // committed on the primary, so read it once and route through the
    // canonical PG mutation path.
    if (entry === null || entry.materialised === true) {
      const row = await findRunInPg(writer, input.runId, input.environmentId);
      if (row) {
        const response = await input.pgMutation(row);
        return { kind: "pg", response };
      }
      // Entry gone with no PG row: the drainer's terminal write itself
      // failed (PG unreachable). Nothing to mutate.
      return { kind: "not_found" };
    }
    // Still QUEUED (requeued after a retryable drain error) or DRAINING —
    // the run hasn't reached PG. Back off with jitter so concurrent
    // waiters on the same draining run don't requery in lockstep.
    if (now() >= deadline) break;
    const jittered = step + Math.floor(random() * step);
    await sleep(jittered);
    step = Math.min(Math.ceil(step * BACKOFF_FACTOR), maxPollStepMs);
  }

  logger.warn("mollifier mutate-with-fallback: drainer resolution timed out", {
    runId: input.runId,
    safetyNetMs,
  });
  return { kind: "timed_out" };
}

// Structural reader interface — accepts both the writer (`prisma`) and the
// replica (`$replica`), which differ slightly in their generated Prisma
// types but share the findFirst surface used here.
type TaskRunReader = {
  taskRun: {
    findFirst(args: {
      where: { friendlyId: string; runtimeEnvironmentId: string };
    }): Promise<TaskRun | null>;
  };
};

async function findRunInPg(
  client: TaskRunReader,
  friendlyId: string,
  environmentId: string,
): Promise<TaskRun | null> {
  return client.taskRun.findFirst({
    where: { friendlyId, runtimeEnvironmentId: environmentId },
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
