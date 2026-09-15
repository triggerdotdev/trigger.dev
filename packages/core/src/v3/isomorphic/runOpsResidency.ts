import { isRunOpsIdBodyShape, runOpsIdV2ShardShape } from "./friendlyId.js";

/**
 * The two store FAMILIES a run/waitpoint can reside in. "NEW" is the dedicated
 * family: one store under gen-1, one per shard under gen-2. Use
 * {@link resolveShard} when the specific store matters.
 */
export type Residency = "LEGACY" | "NEW";

// A routing key naming one store: the reserved gen-1 keys, or a gen-2 shard char.
// Reserved keys are multi-char, so a shard char can never collide with them.
// Note: TS reduces this union to `string` — it documents intent, it does not narrow.
export type ShardKey = "legacy" | "new" | string;

/**
 * Underlying id lineage. "runOpsId" is the label for the NEW-store mint path
 * — a base32hex run-ops v1 id (see friendlyId.ts). It is the value persisted in
 * the runOpsMintKind feature flag. "cuid" is every legacy shape (cuid, nanoid,
 * and the pre-cutover 27-char base62 format).
 */
export type ResidencyKind = "cuid" | "runOpsId";

/** @bugsnag/cuid emits 25-char ids (legacy mint path, flag OFF). */
export const CUID_LENGTH = 25;

/**
 * Kept for API compatibility: the default classifier no longer throws (every
 * non-v1 shape is legacy), but injected classifiers may still raise it and
 * callers still catch it.
 */
export class UnclassifiableRunId extends Error {
  readonly value: string;
  readonly valueLength: number;
  constructor(value: string) {
    super(`Unclassifiable run-ops id: value=${JSON.stringify(value)} (length ${value.length})`);
    this.name = "UnclassifiableRunId";
    this.value = value;
    this.valueLength = value.length;
  }
}

/**
 * Strip a single leading `<prefix>_` (e.g. `run_`, `waitpoint_`) if present,
 * so friendly and internal forms classify identically. Only the FIRST
 * underscore is treated as the prefix separator (mirrors fromFriendlyId's
 * two-part split contract in friendlyId.ts), without importing it.
 */
function internalForm(id: string): string {
  const underscore = id.indexOf("_");
  return underscore === -1 ? id : id.slice(underscore + 1);
}

/**
 * Resolve the store that owns an id. A gen-2 body names its own shard; a gen-1
 * v1 body resolves to the single dedicated store; everything else is legacy.
 *
 * The version char at index 25 is one character, so the v1 and gen-2 shape
 * checks are mutually exclusive by construction — a gen-1 id can never resolve
 * to a shard, and a gen-2 id can never resolve to "new". Total: never throws.
 */
export function resolveShard(id: string): ShardKey {
  const body = internalForm(id);

  const shard = runOpsIdV2ShardShape(body);
  if (shard !== undefined) return shard;

  return isRunOpsIdBodyShape(body) ? "new" : "legacy";
}

/**
 * Returns the id lineage by the version-char rule: a well-formed run-ops v1 body
 * (version "1") or gen-2 body (version "2") is "runOpsId"; everything else —
 * including malformed shapes of either — is "cuid" (legacy). Total: never throws.
 * Transition: pre-cutover 27-char base62 ids (the old NEW-mint format) classify
 * LEGACY, so ship this with the base32hex generator only once any 27-char
 * NEW-resident runs are drained/disposable — no live run is misrouted mid-cutover.
 */
export function classifyKind(id: string): ResidencyKind {
  return resolveShard(id) === "legacy" ? "cuid" : "runOpsId";
}

/** Classification is total now; kept for API compatibility. */
export function isClassifiable(_id: string): boolean {
  return true;
}

/** Map an id to its owning run-ops store by the version-char rule. */
export function classifyResidency(id: string): Residency {
  return classifyKind(id) === "runOpsId" ? "NEW" : "LEGACY";
}

/** Primary public name (RoutingRunStore / cross-seam guard). */
export const ownerEngine = classifyResidency;
