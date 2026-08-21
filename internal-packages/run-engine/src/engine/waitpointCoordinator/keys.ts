/**
 * Waitpoint coordination keyspace. Two hash tags, deliberately:
 *
 *  - `wp:{waitpointId}` — the record, its status and completion envelope, plus the
 *    watcher hash. A waitpoint has N watcher runs, so it cannot live under any single
 *    run's tag.
 *  - `wp:run:{runId}:*` — one run's pending set, delivered set and edge set. The pending
 *    set's cardinality is the blocked-versus-unblocked signal, so it has to be readable
 *    atomically, which means one slot.
 *
 * Every script therefore touches exactly one tag, and assertSingleSlot enforces it on
 * every invocation. A cluster would reject a cross-slot script; a single-node test server
 * would not, so this assertion is the only thing standing between a cross-slot bug and
 * production.
 */

export type WaitpointKeys = { record: string; watchers: string };
export type RunBlockKeys = { pend: string; done: string; edge: string };

export function waitpointKeys(waitpointId: string): WaitpointKeys {
  const base = `wp:{${waitpointId}}`;
  return { record: base, watchers: `${base}:w` };
}

export function runBlockKeys(runId: string): RunBlockKeys {
  const base = `wp:run:{${runId}}`;
  return { pend: `${base}:pend`, done: `${base}:done`, edge: `${base}:edge` };
}

export function idempotencyKey(environmentId: string, key: string): string {
  return `wp:idem:{${environmentId}}:${key}`;
}

// "#" separates the id from the index. A waitpoint id and a run id never contain "#", so
// the split is unambiguous. An absent index collapses onto the empty suffix, which is how
// the partial unique index on a null batchIndex behaves; index 0 keeps its own field,
// because "0" and "" are different strings.
const SEPARATOR = "#";

export function edgeField(waitpointId: string, batchIndex?: number | null): string {
  return `${waitpointId}${SEPARATOR}${batchIndex ?? ""}`;
}

export function watcherField(runId: string, batchIndex?: number | null): string {
  return `${runId}${SEPARATOR}${batchIndex ?? ""}`;
}

export function waitpointIdFromEdgeField(field: string): string | undefined {
  const separator = field.lastIndexOf(SEPARATOR);
  return separator === -1 ? undefined : field.slice(0, separator);
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

const HASH_TAG = /\{([^}]+)\}/;

/**
 * Throw unless every key carries the same non-empty hash tag. Called on every script
 * invocation, because the keys embed ids and are only known at call time.
 */
export function assertSingleSlot(operation: string, keys: string[]): void {
  let tag: string | undefined;

  for (const key of keys) {
    const match = HASH_TAG.exec(key);
    const found = match?.[1];
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
