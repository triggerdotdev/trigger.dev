/**
 * Waitpoint coordination keyspace. Three hash tags, deliberately:
 *
 *  - `wp:v1:{waitpointId}` — the record, its status and completion envelope, the watcher
 *    hash, the watcher paging queue and the durable fanout entry. A waitpoint has N
 *    watcher runs, so it cannot live under any single run's tag. Completion and the
 *    creation of its fanout work are one atomic script, which is only possible because
 *    all four keys share this tag.
 *  - `wp:v1:run:{runId}:*` — one run's pending set, delivered set, edge set and block state.
 *    The pending set's cardinality is the blocked-versus-unblocked signal, so it has to be
 *    readable atomically, which means one slot.
 *  - `wp:v1:f{p<n>}:*` — the fanout discovery indexes. A waitpoint's own partition cannot
 *    hold an index over other waitpoints, so the worker finds owed fanout work through a
 *    fixed set of partitioned sorted sets instead of a keyspace scan.
 *
 * Every script therefore touches exactly one tag, and assertSingleSlot enforces it on
 * every invocation. A cluster would reject a cross-slot script; a single-node test server
 * would not, so this assertion is the only thing standing between a cross-slot bug and
 * production.
 */

/**
 * The versioned Waitpoint namespace, kept separate from every other subsystem's.
 *
 * Versioned because the KEY SHAPES and the data behind them are a persisted format: a
 * future change to how a record, a watcher queue or a fanout entry is laid out needs a
 * namespace it can move to without reading the old one. The Lua command names are not
 * versioned — those are client-local and redefined on every connect.
 *
 * Nothing has ever written this subsystem in production, so there is no unversioned data
 * to be compatible with and no migration to perform.
 */
const NAMESPACE = "wp:v1";

export type WaitpointKeys = {
  record: string;
  watchers: string;
  /** Watcher fields in registration order. The fanout worker's paging cursor. */
  queue: string;
  /** The durable fanout entry: claim, lease, failure streak and drain state. */
  fanout: string;
};
export type RunBlockKeys = { pend: string; done: string; edge: string; state: string };
export type FanoutIndexKeys = { due: string; quarantine: string };

export function waitpointKeys(waitpointId: string): WaitpointKeys {
  const base = `${NAMESPACE}:{${waitpointId}}`;
  return { record: base, watchers: `${base}:w`, queue: `${base}:q`, fanout: `${base}:f` };
}

export function runBlockKeys(runId: string): RunBlockKeys {
  const base = `${NAMESPACE}:run:{${runId}}`;
  return {
    pend: `${base}:pend`,
    done: `${base}:done`,
    edge: `${base}:edge`,
    state: `${base}:st`,
  };
}

/**
 * How many partitions the fanout indexes are split across.
 *
 * A CONSTANT, not an option. The partition of a waitpoint is derived from its id, so
 * changing this number strands every entry already filed under the old modulus — the
 * worker would stop finding owed fanout work for exactly the waitpoints that were mid-
 * fanout at deploy time. Changing it needs a drain-and-migrate, not an edit.
 *
 * 16 keeps a full sweep at 16 bounded reads per tick while spreading the index writes
 * across 16 cluster slots.
 */
export const FANOUT_PARTITION_COUNT = 16;

/**
 * FNV-1a over the id, then modulo. Deliberately not a hash imported from elsewhere: the
 * partition assignment is a persisted decision, so the arithmetic that produces it has to
 * be visible and fixed here rather than tracking whatever a shared helper does next.
 */
export function fanoutPartition(waitpointId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < waitpointId.length; i++) {
    hash ^= waitpointId.charCodeAt(i);
    // >>> 0 after each step: JS bitwise ops are signed 32-bit, and Math.imul keeps the
    // multiply from losing the high bits to float64.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % FANOUT_PARTITION_COUNT;
}

/**
 * The two indexes for one partition, under a shared tag so a script may move an entry
 * from one to the other atomically.
 */
export function fanoutIndexKeys(partition: number): FanoutIndexKeys {
  const base = `${NAMESPACE}:f{p${partition}}`;
  return { due: `${base}:due`, quarantine: `${base}:quar` };
}

export function idempotencyKey(environmentId: string, key: string): string {
  return `${NAMESPACE}:idem:{${environmentId}}:${key}`;
}

// "#" separates the id from the index. An absent index collapses onto the empty suffix,
// which is how the partial unique index on a null batchIndex behaves; index 0 keeps its
// own field, because "0" and "" are different strings. The split back to an id below is
// taken from the LAST "#", not the first, so this stays unambiguous even if a waitpoint id
// or a run id ever contains "#" itself.
const SEPARATOR = "#";

export function edgeField(waitpointId: string, batchIndex?: number | null): string {
  return `${waitpointId}${SEPARATOR}${batchIndex ?? ""}`;
}

/**
 * BLOCK-SCOPED, and that is the whole point.
 *
 * Keyed on the run alone, a run that blocked on a waitpoint, failed to resume, and then
 * blocked on the SAME waitpoint again collided with its own earlier registration: HSETNX
 * kept the first entry, so the stored watcher still named the first block. Completion then
 * delivered under that obsolete block id, the run's shard rejected it as stale, and the
 * current block never heard — a lost wake-up.
 *
 * With the block in the field, the two registrations are independent: the obsolete one is
 * delivered and rejected on its own, the current one is delivered and accepted, and a
 * delayed retry of the older registration can neither displace nor retire the newer.
 */
export function watcherField(runId: string, blockId: string, batchIndex?: number | null): string {
  return `${runId}${SEPARATOR}${batchIndex ?? ""}${SEPARATOR}${blockId}`;
}

// The last-"#" rule here is re-implemented as a Lua pattern in runClear (scripts.ts). This
// function has no caller besides its own test, so that test is what pins the rule as a
// specification the Lua mirrors, not just documentation of this helper.
export function waitpointIdFromEdgeField(field: string): string | undefined {
  const separator = field.lastIndexOf(SEPARATOR);
  return separator === -1 ? undefined : field.slice(0, separator);
}

/**
 * The inverse of {@link edgeField}, for the rollover cleanup that has to turn a superseded
 * block's stored edge fields back into the arguments `unregisterWatcher` needs.
 *
 * Splits on the LAST separator for the same reason `waitpointIdFromEdgeField` does: a waitpoint
 * id may itself contain one. An empty index suffix decodes to undefined, which is how
 * `edgeField` encodes an absent batch index — and "0" must survive as 0, not collapse to
 * undefined, so the check is on emptiness rather than falsiness.
 */
export function parseEdgeField(
  field: string
): { waitpointId: string; batchIndex?: number } | undefined {
  const separator = field.lastIndexOf(SEPARATOR);
  if (separator === -1) {
    return undefined;
  }
  const waitpointId = field.slice(0, separator);
  if (waitpointId === "") {
    return undefined;
  }
  const suffix = field.slice(separator + 1);
  if (suffix === "") {
    return { waitpointId };
  }
  const batchIndex = Number(suffix);
  return Number.isInteger(batchIndex) ? { waitpointId, batchIndex } : undefined;
}

export class WaitpointKeyTagError extends Error {
  constructor(operation: string, keys: string[], offending: string) {
    super(
      `Waitpoint operation ${operation} would span more than one cluster slot: ` +
        `key ${JSON.stringify(offending)} does not share the tag of ${JSON.stringify(keys)}`
    );
    this.name = "WaitpointKeyTagError";
  }
}

// Redis's own keyHashSlot rule: the FIRST `{`, then the FIRST `}` after it. A missing brace
// or an empty pair means no tag, and Redis hashes the whole key. A regex would instead find
// the first NON-empty pair, disagreeing with Redis on `wp:{}{a}`.
function hashTag(key: string): string | undefined {
  const open = key.indexOf("{");
  if (open === -1) return undefined;

  const close = key.indexOf("}", open + 1);
  if (close === -1 || close === open + 1) return undefined;

  return key.slice(open + 1, close);
}

/**
 * Throw unless every key carries the same non-empty hash tag. Called on every script
 * invocation, because the keys embed ids and are only known at call time.
 */
export function assertSingleSlot(operation: string, keys: string[]): void {
  let tag: string | undefined;

  for (const key of keys) {
    const found = hashTag(key);
    if (!found) {
      throw new WaitpointKeyTagError(operation, keys, key);
    }
    if (tag === undefined) {
      tag = found;
    } else if (found !== tag) {
      throw new WaitpointKeyTagError(operation, keys, key);
    }
  }
}
