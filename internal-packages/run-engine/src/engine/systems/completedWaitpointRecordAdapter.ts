// Resolves completed waitpoint ids to CompletedWaitpointRecords, one per distinct id. Legacy ids
// resolve through Postgres, and store-format ids through the waitpoint store.
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { CompletedWaitpointRecord } from "@internal/run-store";
import type {
  WaitpointCompletion,
  WaitpointRecordInput,
  WaitpointStoredRecord,
} from "../waitpointCoordinator/storeCoordinator.js";

/**
 * Thrown when a distinct id does not resolve to exactly one complete record. On a resume, the throw
 * aborts the transition before it commits, so a partial cycle is never published.
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

/** Postgres half: one record per distinct id. A missing id is left out. */
export type LegacyCompletedWaitpointReader = (ids: string[]) => Promise<CompletedWaitpointRecord[]>;

/** Store half: a map of the ids present. A missing id is not a reader failure. */
export type StoreCompletedWaitpointReader = (
  ids: string[]
) => Promise<Map<string, WaitpointStoredRecord>>;

/** Maps a store record to a CompletedWaitpointRecord as of `nowMs`. Throws with no completion. */
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
 * True when a user-provided idempotency key is active at `nowMs`: strictly before its expiry, to
 * match the `PEXPIREAT` on its reservation. The store keeps the key on the record after the
 * reservation expires, and a newer waitpoint can own it then (as with `inactiveIdempotencyKey` in
 * Postgres). Throws on an expiry that does not parse.
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
  // Before the null check: the store can hold a RUN success's output as null because it is derived
  // from TaskRun.output. Null must still give deriveFromRun here, unlike the Postgres write side.
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
 * Returns one record per distinct id in `requestedIds`, in first-seen order. The caller keeps the
 * ordered list with its duplicates. `parseWaitpointId` puts each id in exactly one half, so a store
 * id never falls back to Postgres. Throws UnresolvableCompletedWaitpointRecordsError on any gap.
 */
export async function resolveCompletedWaitpointRecords(args: {
  requestedIds: string[];
  legacyReader: LegacyCompletedWaitpointReader;
  storeReader?: StoreCompletedWaitpointReader;
  /** Called once. Defaults to `Date.now`. */
  now?: () => number;
}): Promise<CompletedWaitpointRecord[]> {
  const { requestedIds, legacyReader, storeReader } = args;

  // One instant for every record, so records that straddle a key expiry are judged consistently.
  const nowMs = (args.now ?? Date.now)();

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
        // A corrupt blob. Keeping it would file the wrong record under `id`.
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

  if (byId.size !== distinctIds.length) {
    throw new UnresolvableCompletedWaitpointRecordsError(
      `Resolved ${byId.size} record(s) for ${distinctIds.length} distinct waitpoint id(s)`
    );
  }

  return distinctIds.map((id) => byId.get(id)!);
}
