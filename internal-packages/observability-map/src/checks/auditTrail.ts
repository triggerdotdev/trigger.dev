import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";
import { isTrivial } from "../triviality.js";

const ID = "audit-trail";

/**
 * Calls that write a record of who did something.
 *
 * This list named nothing at all until it was checked. `auditLog`, `recordAudit` and
 * `writeAuditEvent` are exported nowhere in apps/webapp, packages/core or internal-packages,
 * so the pass branch below could never fire, every applicable route failed, and both renderers
 * printed "No audit helper exists in the webapp" while `models/admin.server.ts` was writing
 * `prisma.impersonationAuditLog.create({ action, adminId, targetId, ipAddress })` on two paths.
 * The rot went unnoticed because `webappSymbols.test.ts` covered every other name list in the
 * package and not this one. It covers this one now.
 *
 * All three names below reach that write: `redirectWithImpersonation` writes the START row,
 * `clearImpersonation` writes the STOP row, and `startImpersonation` returns one or the other.
 *
 * Two of them are also in `SENSITIVE_SYMBOLS`, which is worth saying out loud because it looks like
 * the circularity the sensitivity list was cleaned up to remove. It is not quite the same shape:
 * `requireAdminApiRequest` was a pure mitigation counted as a hazard, whereas impersonation
 * genuinely is the hazard AND genuinely writes the record. The consequence is real all the same, so
 * here it is: a route made sensitive only by one of these calls cannot fail this check, because the
 * call that put it in the cohort is the call that satisfies it.
 *
 * Matched against `importedNames` and `calleeNames`, so an import of one counts. Nothing matches
 * the underlying `prisma.impersonationAuditLog.create` path directly: `calleeNames` records
 * `create` for a member call, and no route in the tree writes the row itself.
 */
export const AUDIT_SYMBOLS = [
  "redirectWithImpersonation",
  "clearImpersonation",
  "startImpersonation",
];

/**
 * Whether a sensitive mutation leaves a record of who did it.
 *
 * Applicability follows the same rule as every other check, which it did not before: would this
 * evidence necessarily be visible in the body if it existed? It gated on sensitivity and
 * `hasAction` alone, so on `resources.impersonation.ts`, a four-statement body, `auth-boundary`
 * declined to judge because any guard would be behind the import while this check accused the route
 * over an audit write behind that same import. Two checks, opposite verdicts, one fact.
 *
 * So a trivial body is not-applicable here too. A delegating one is handled centrally by
 * `scoreEntry`, which answers for every check before any of them runs, so there is no test for it
 * here. The order matters and mirrors
 * `auth-boundary`: a known audit call is read BEFORE the triviality exemption, because presence is
 * evidence even where absence is not.
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
