import { KSUID_STRING_LENGTH } from "./friendlyId.js";

/** The two run-ops stores a run/waitpoint can reside in. */
export type Residency = "LEGACY" | "NEW";

/** Underlying id format. cuid → LEGACY store, ksuid → NEW store. */
export type ResidencyKind = "cuid" | "ksuid";

/** @bugsnag/cuid emits 25-char ids (cuid path, flag OFF). */
export const CUID_LENGTH = 25;
/** KSUID / nanoid-27 emits 27-char ids (ksuid path, flag ON). */
export const KSUID_LENGTH = KSUID_STRING_LENGTH;

/** Thrown when an id length matches neither the cuid nor the ksuid margin. */
export class UnclassifiableRunId extends Error {
  readonly value: string;
  readonly valueLength: number;
  constructor(value: string) {
    super(
      `Unclassifiable run-ops id: length ${value.length} matches neither cuid (${CUID_LENGTH}) nor ksuid (${KSUID_LENGTH}) — value=${JSON.stringify(
        value
      )}`
    );
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

/** Returns the underlying id FORMAT (cuid|ksuid), or throws if unclassifiable. */
export function classifyKind(id: string): ResidencyKind {
  const internal = internalForm(id);
  if (internal.length === CUID_LENGTH) return "cuid";
  if (internal.length === KSUID_LENGTH) return "ksuid";
  throw new UnclassifiableRunId(id);
}

/** Non-throwing predicate: is this id length one we can classify? */
export function isClassifiable(id: string): boolean {
  const len = internalForm(id).length;
  return len === CUID_LENGTH || len === KSUID_LENGTH;
}

/** Map an id to its owning run-ops store by length. Throws on ambiguity. */
export function classifyResidency(id: string): Residency {
  return classifyKind(id) === "ksuid" ? "NEW" : "LEGACY";
}

/** Primary public name (RoutingRunStore / cross-seam guard). */
export const ownerEngine = classifyResidency;
