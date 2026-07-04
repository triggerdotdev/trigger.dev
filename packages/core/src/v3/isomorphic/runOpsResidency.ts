import { isRunOpsIdBody } from "./friendlyId.js";

/** The two run-ops stores a run/waitpoint can reside in. */
export type Residency = "LEGACY" | "NEW";

/**
 * Underlying id lineage. "ksuid" is the historical label for the NEW-store
 * mint path (now a base32hex run-ops v1 id — see friendlyId.ts); it is kept
 * because the value is persisted in the runOpsMintKsuid feature flag. "cuid"
 * is every legacy shape (cuid, nanoid, pre-cutover 27-char base62).
 */
export type ResidencyKind = "cuid" | "ksuid";

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
 * Returns the id lineage by the version-char rule: a well-formed run-ops v1
 * body (26 chars, version "1" at index 25, base32hex alphabet) is "ksuid"
 * (NEW store); everything else — including malformed v1 shapes — is "cuid"
 * (legacy). Total: never throws.
 */
export function classifyKind(id: string): ResidencyKind {
  return isRunOpsIdBody(internalForm(id)) ? "ksuid" : "cuid";
}

/** Classification is total now; kept for API compatibility. */
export function isClassifiable(_id: string): boolean {
  return true;
}

/** Map an id to its owning run-ops store by the version-char rule. */
export function classifyResidency(id: string): Residency {
  return classifyKind(id) === "ksuid" ? "NEW" : "LEGACY";
}

/** Primary public name (RoutingRunStore / cross-seam guard). */
export const ownerEngine = classifyResidency;
