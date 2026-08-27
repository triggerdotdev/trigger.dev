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

// "#" separates the id from the index. An absent index collapses onto the empty suffix,
// which is how the partial unique index on a null batchIndex behaves; index 0 keeps its
// own field, because "0" and "" are different strings. The split back to an id below is
// taken from the LAST "#", not the first, so this stays unambiguous even if a waitpoint id
// or a run id ever contains "#" itself.
const SEPARATOR = "#";

export function edgeField(waitpointId: string, batchIndex?: number | null): string {
  return `${waitpointId}${SEPARATOR}${batchIndex ?? ""}`;
}

export function watcherField(runId: string, batchIndex?: number | null): string {
  return `${runId}${SEPARATOR}${batchIndex ?? ""}`;
}

// The last-"#" rule here is re-implemented as a Lua pattern in runClear (scripts.ts). This
// function has no caller besides its own test, so that test is what pins the rule as a
// specification the Lua mirrors, not just documentation of this helper.
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
