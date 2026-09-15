import type { CheckResult, EntryPoint } from "../types.js";
import { errorClassification } from "./errorClassification.js";
import { authBoundary } from "./authBoundary.js";
import { authScope } from "./authScope.js";
import { requestContext } from "./requestContext.js";
import { auditTrail } from "./auditTrail.js";

export type Check = { id: string; run: (ep: EntryPoint) => CheckResult };

/** audit-trail is scored separately, see score.ts. */
export const CHECKS: Check[] = [
  errorClassification,
  authBoundary,
  authScope,
  requestContext,
  auditTrail,
];
export const SCORED_CHECK_IDS = [
  "error-classification",
  "auth-boundary",
  "auth-scope",
  "request-context",
];
