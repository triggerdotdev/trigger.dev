// The Waitpoint-side adapter TRES consumes when it builds a fresh Redis-primary completed-waitpoint
// cycle. It turns the run's ordered blocker ids into exactly one frozen CompletedWaitpointRecord per
// DISTINCT id, resolving each id through the coordinator its SHAPE names — legacy ids through Postgres,
// store-format ids through MemoryDB — and combines the two residencies into one complete record set.
//
// The frozen record shape and the write-side rules live in completedWaitpointResolver.ts and
// completedWaitpointFreeze.test.ts; this file only routes ids to the right source and maps a
// store-resident completion into that same shape. It never touches Redis or Postgres directly: the
// readers are injected, so the partition/coverage logic is a pure function of them.
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { CompletedWaitpointRecord } from "@internal/run-store";
import type {
  WaitpointCompletion,
  WaitpointRecordInput,
  WaitpointStoredRecord,
} from "../waitpointCoordinator/storeCoordinator.js";

/**
 * The whole resolution failed loudly. Every path that leaves a distinct id without exactly one
 * complete record throws this: a missing legacy or store record, a store record that is not
 * COMPLETED, a store id with no store reader, or a coverage mismatch. TRES turns a throw here into a
 * rolled-back transition, so a partial cycle is never published.
 */
export class UnresolvableCompletedWaitpointRecordsError extends Error {
  constructor(
    message: string,
    readonly waitpointId?: string
  ) {
    super(message);
    this.name = "UnresolvableCompletedWaitpointRecordsError";
  }
}

/** Resolves the legacy (Postgres) half: one record per DISTINCT id, missing ids simply absent. */
export type LegacyCompletedWaitpointReader = (ids: string[]) => Promise<CompletedWaitpointRecord[]>;

/** Resolves the store (MemoryDB) half: a map of the ids PRESENT in the store. Absence != failure. */
export type StoreCompletedWaitpointReader = (
  ids: string[]
) => Promise<Map<string, WaitpointStoredRecord>>;

/**
 * Map a store-resident record + completion to the frozen CompletedWaitpointRecord shape, as of
 * `nowMs` (the resolver's single effective time).
 *
 * Output selection mirrors the Postgres write side (`recordOutputFor`): a RUN success re-derives its
 * output byte-identically from TaskRun.output, so it carries `deriveFromRun` and NOT a copy — even an
 * offloaded one — which keeps a potentially large inline value out of the cycle payload. Everything
 * else passes the store's own inline/ref discrimination straight through.
 *
 * The idempotency key is the already-resolved user-visible value, gated on its expiry (see
 * `idempotencyKeyIsActive`): the store keeps the original key on the immutable record even after its
 * separate reservation has expired via `PEXPIREAT`, so exposing it unconditionally would let an old
 * waitpoint present a key a replacement waitpoint has since taken over — the exact state the Postgres
 * path drops through `inactiveIdempotencyKey`.
 */
export function storeRecordToCompletedWaitpointRecord(
  entry: WaitpointStoredRecord,
  nowMs: number
): CompletedWaitpointRecord {
  const { record, completion } = entry;
  if (!completion) {
    throw new UnresolvableCompletedWaitpointRecordsError(
      `Waitpoint ${record.id} is COMPLETED in the store with no completion envelope`,
      record.id
    );
  }

  return {
    id: record.id,
    friendlyId: record.friendlyId,
    type: record.type,
    completedAt: completion.completedAt,
    outputType: completion.outputType,
    outputIsError: completion.outputIsError,
    output: storeRecordOutput(record, completion),
    completedByTaskRunId: record.completedByTaskRunId,
    completedByBatchId: record.completedByBatchId,
    completedAfter: record.completedAfter,
    idempotencyKey: idempotencyKeyIsActive(record, nowMs) ? record.idempotencyKey : undefined,
  };
}

/**
 * Whether a store record's idempotency key is user-visible at `nowMs`.
 *
 * A system-generated or absent key is never exposed, and its expiry is not even consulted. A
 * user-provided key with no expiry is always active. One with an expiry is active only STRICTLY before
 * that instant: at the exact expiry ms the key is already gone, matching the `PEXPIREAT` that retires
 * its reservation. A stored expiry that will not parse is corrupted durable state, so it fails loud
 * rather than exposing the key or silently reinterpreting it.
 */
function idempotencyKeyIsActive(record: WaitpointRecordInput, nowMs: number): boolean {
  if (!record.userProvidedIdempotencyKey || !record.idempotencyKey) {
    return false;
  }
  const raw = record.idempotencyKeyExpiresAt;
  if (raw === undefined) {
    return true;
  }
  const expiresAtMs = Date.parse(raw);
  if (Number.isNaN(expiresAtMs)) {
    throw new UnresolvableCompletedWaitpointRecordsError(
      `Waitpoint ${record.id} has a malformed idempotencyKeyExpiresAt: ${JSON.stringify(raw)}`,
      record.id
    );
  }
  return expiresAtMs > nowMs;
}

function storeRecordOutput(
  record: WaitpointRecordInput,
  completion: WaitpointCompletion
): CompletedWaitpointRecord["output"] {
  // FIRST, before the null and inline/ref branches: a RUN success re-derives its output
  // byte-identically from TaskRun.output, so it carries deriveFromRun and never a copy. This
  // precedes the null check deliberately — unlike the Postgres write side, where a null output means
  // "none". The store may store a RUN success's output as null precisely BECAUSE it is re-derivable
  // and was never copied, so a null here must still resolve to deriveFromRun, not to no output.
  if (record.type === "RUN" && !completion.outputIsError && record.completedByTaskRunId) {
    return { deriveFromRun: true };
  }
  const output = completion.output;
  if (output === null) {
    return null;
  }
  if ("ref" in output) {
    return { ref: output.ref };
  }
  return { inline: output.inline };
}

/**
 * Resolve the complete frozen record set for one Redis-primary resume.
 *
 * `requestedIds` is the caller's ordered, duplicate-preserving blocker list. The returned records are
 * one per DISTINCT id, in first-seen order — the ordered/duplicate reference list and its indexes stay
 * with the caller's separate `completedWaitpoints` array, which is what the read-time enhancement step
 * expands. Every distinct id is resolved exactly once even when referenced repeatedly.
 *
 * Partitioning is by id SHAPE and is total and exclusive: `parseWaitpointId` classes every id as
 * either legacy or store-format, never both and never neither. A store id therefore never reaches
 * Postgres, and a missing store record never falls back to it.
 */
export async function resolveCompletedWaitpointRecords(args: {
  requestedIds: string[];
  legacyReader: LegacyCompletedWaitpointReader;
  storeReader?: StoreCompletedWaitpointReader;
  /** Effective-time clock, called exactly ONCE. Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}): Promise<CompletedWaitpointRecord[]> {
  const { requestedIds, legacyReader, storeReader } = args;

  // Captured ONCE for the whole invocation, so a cycle whose records straddle an idempotency-key
  // expiry boundary judges every record against the same instant instead of a per-record clock.
  const nowMs = (args.now ?? Date.now)();

  // First-seen order, duplicates collapsed: the distinct set we must cover exactly once each.
  const distinctIds: string[] = [];
  const seen = new Set<string>();
  const legacyIds: string[] = [];
  const storeIds: string[] = [];
  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    distinctIds.push(id);
    if (parseWaitpointId(id).format === "legacy") {
      legacyIds.push(id);
    } else {
      storeIds.push(id);
    }
  }

  if (storeIds.length > 0 && !storeReader) {
    throw new UnresolvableCompletedWaitpointRecordsError(
      `${storeIds.length} store-format waitpoint id(s) in the cycle but no store coordinator is available to resolve them`,
      storeIds[0]
    );
  }

  const byId = new Map<string, CompletedWaitpointRecord>();

  if (legacyIds.length > 0) {
    const legacySet = new Set(legacyIds);
    const legacyRecords = await legacyReader(legacyIds);
    for (const rec of legacyRecords) {
      if (!legacySet.has(rec.id)) {
        // The reader returned a record for an id we never asked for (or a store id): an integrity
        // failure, not something to silently keep.
        throw new UnresolvableCompletedWaitpointRecordsError(
          `Legacy reader returned an unrequested record ${rec.id}`,
          rec.id
        );
      }
      if (byId.has(rec.id)) {
        throw new UnresolvableCompletedWaitpointRecordsError(
          `Legacy reader returned a duplicate record for ${rec.id}`,
          rec.id
        );
      }
      byId.set(rec.id, rec);
    }
    for (const id of legacyIds) {
      if (!byId.has(id)) {
        throw new UnresolvableCompletedWaitpointRecordsError(
          `No completed legacy waitpoint record for ${id}`,
          id
        );
      }
    }
  }

  if (storeIds.length > 0) {
    // storeReader is defined here (guarded above). A Redis failure throws out of it; a genuinely
    // absent id comes back simply missing from the map — the two are never conflated.
    const storeMap = await storeReader!(storeIds);
    for (const id of storeIds) {
      const entry = storeMap.get(id);
      if (!entry) {
        throw new UnresolvableCompletedWaitpointRecordsError(
          `No store waitpoint record for ${id}`,
          id
        );
      }
      if (entry.record.id !== id) {
        // The store returned a record whose own id is not the one we asked for: a wrong or corrupted
        // blob. Trusting it would file the mismatched record under `id` and lose the real one.
        throw new UnresolvableCompletedWaitpointRecordsError(
          `Store returned record ${entry.record.id} for requested id ${id}`,
          id
        );
      }
      if (entry.status !== "COMPLETED") {
        throw new UnresolvableCompletedWaitpointRecordsError(
          `Store waitpoint ${id} is ${entry.status}, not COMPLETED`,
          id
        );
      }
      byId.set(id, storeRecordToCompletedWaitpointRecord(entry, nowMs));
    }
  }

  // Belt and braces over the per-half checks: exactly one record per distinct id, nothing extra.
  if (byId.size !== distinctIds.length) {
    throw new UnresolvableCompletedWaitpointRecordsError(
      `Resolved ${byId.size} record(s) for ${distinctIds.length} distinct waitpoint id(s)`
    );
  }

  return distinctIds.map((id) => byId.get(id)!);
}
