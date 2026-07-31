import type { CheckResult, EntryPoint } from "../types.js";
import { classifySensitivity } from "../sensitivity.js";

const ID = "audit-trail";

const AUDIT_SYMBOLS = ["auditLog", "recordAudit", "writeAuditEvent"];

/**
 * Whether a sensitive mutation leaves a record of who did it. Nothing in the webapp writes one
 * today, so every applicable entry point fails: the check states the gap rather than measuring
 * variation between routes, which is why the score leaves it out.
 */
export const auditTrail = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    // Mutations only: a sensitive read does not need an actor record.
    if (!classifySensitivity(ep).sensitive || !ep.hasAction) {
      return { id: ID, status: "not-applicable", detail: "not a sensitive mutation" };
    }
    const symbols = new Set([...ep.importedNames, ...ep.calleeNames]);
    return AUDIT_SYMBOLS.some((s) => symbols.has(s))
      ? { id: ID, status: "pass", detail: "records an audit event" }
      : { id: ID, status: "fail", detail: "sensitive mutation with no audit record" };
  },
};
