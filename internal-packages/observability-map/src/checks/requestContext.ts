import type { CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";
import { usesBuilder } from "./errorClassification.js";

const ID = "request-context";

/** `requireUserId`, `authenticateApiRequest`: the request comes back with an identity attached. */
const GUARD = /^(require|authenticate)/;

/** `findProjectBySlug`, `loadProjectEnvironmentFromRequest`, `getUserSession`, `findWaitpoint`. */
const RESOLVE = /^(find|get|load|resolve|lookup)/;
const SCOPE =
  /(environment|project|organization|org|run|user|account|waitpoint|deployment|batch|schedule|task)/i;

/**
 * Whether the body ever works out who or what the request is for. A failure in a route that has
 * resolved a user, an environment or a project can be attributed to one when it is reported; a
 * route that resolves none of them has nothing to attribute a failure to, wherever it is logged.
 */
function resolvesRequestIdentity(ep: EntryPoint): boolean {
  return ep.calleeNames.some((n) => GUARD.test(n) || (RESOLVE.test(n) && SCOPE.test(n)));
}

/**
 * The design asked whether an identifier reaches the failure path, and looked for one by matching
 * `environmentId` and friends against `ep.source`. That is the whole file: a route whose React
 * component renders `runId` would pass a check about its loader's error handling.
 *
 * The body-scoped substitute is weaker. `EntryPoint` records the names of the functions a body
 * calls, not the arguments passed to them, so `logger.error("failed", { environmentId })` and
 * `logger.error("failed")` are the same to this check. What is left is the identity the body
 * resolves, which the callee names do carry. It answers a related question rather than the
 * original one, and its evidence overlaps heavily with `auth-boundary`: see the task 5 report.
 */
export const requestContext = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    if (usesBuilder(ep)) {
      return { id: ID, status: "pass", detail: "attributed by the builder" };
    }
    if (resolvesRequestIdentity(ep)) {
      return { id: ID, status: "pass", detail: "resolves a request identity" };
    }
    return {
      id: ID,
      status: "fail",
      detail: "resolves no user, environment or project, so a failure here names nobody",
    };
  },
};
