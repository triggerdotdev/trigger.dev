import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { isTrivial } from "../triviality.js";

const ID = "audit-trail";

/**
 * Calls that write a record of who did something. All three reach
 * `prisma.impersonationAuditLog.create` in `models/admin.server.ts`, which nothing here matches
 * directly, because `calleeNames` records `create` for a member call and no route writes the row
 * itself. Matched against `importedNames` too, so an import counts.
 *
 * Two of these are also in `SENSITIVE_SYMBOLS`, so a route made sensitive only by one of them cannot
 * fail this check: the call that put it in the cohort is the call that satisfies it. That is not the
 * circularity the sensitivity list was cleaned up to remove, since impersonation genuinely is the
 * hazard AND genuinely writes the record, but the consequence is real either way.
 */
export const AUDIT_SYMBOLS = [
  "redirectWithImpersonation",
  "clearImpersonation",
  "startImpersonation",
];

/**
 * Whether a sensitive mutation leaves a record of who did it. Applicability follows the same rule as
 * every other check, which it did not before: gating on sensitivity and `hasAction` alone had this
 * check accusing `resources.impersonation.ts` over an audit write behind the very import
 * `auth-boundary` declined to judge it for.
 *
 * The order below matters and mirrors `auth-boundary`: a known audit call is read BEFORE the
 * triviality exemption, because presence is evidence even where absence is not.
 */
export const auditTrail = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    // Mutations only: a sensitive read does not need an actor record.
    if (!classifySensitivity(ep).sensitive || !ep.hasAction) {
      return { id: ID, status: "not-applicable", detail: "not a sensitive mutation" };
    }
    const symbols = new Set([...ep.importedNames, ...ep.calleeNames]);
    if (AUDIT_SYMBOLS.some((s) => symbols.has(s))) {
      return { id: ID, status: "pass", detail: "records an audit event" };
    }
    if (isTrivial(ep)) {
      return {
        id: ID,
        status: "not-applicable",
        detail:
          "cannot verify: no privileged work in the body, any audit write is behind an import",
      };
    }
    return { id: ID, status: "fail", detail: "sensitive mutation with no audit record" };
  },
};
