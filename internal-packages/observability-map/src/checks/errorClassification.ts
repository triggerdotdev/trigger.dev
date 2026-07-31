import type { CatchEvidence, CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";

const ID = "error-classification";

/**
 * The route builders that own the failure path: they authenticate, they catch, they pass a thrown
 * `Response` through untouched and report anything else through `logBoundaryError` before
 * answering 500. A route wrapped in one of these has its errors classified for it.
 *
 * `createSSELoader` is deliberately absent. It turns a non-Response error into a 500 but does not
 * authenticate, so counting it here would hand two routes a free pass on `auth-boundary`.
 * `createHybridActionApiRoute`, which the design named, exists nowhere in the tree.
 */
export const BUILDERS = new Set([
  "createLoaderApiRoute",
  "createActionApiRoute",
  "createLoaderPATApiRoute",
  "createActionPATApiRoute",
  "createMultiMethodApiRoute",
  "createLoaderWorkerApiRoute",
  "createActionWorkerApiRoute",
  "dashboardLoader",
  "dashboardAction",
]);

/**
 * Whether a catch clause is a guard rather than the route's error handling: it wraps a parse and
 * covers less than half the entry point's statements. Both halves matter. `guardsParse` alone lets
 * `otel.v1.logs.ts` off, whose catch covers 15 of its 18 statements and merely happens to contain a
 * `request.json()`, and that is a real swallow. The coverage test is relative to the body rather
 * than a second absolute threshold, so it holds for a three-statement route and a fifty-statement
 * one alike.
 */
export function isParseGuard(clause: CatchEvidence, ep: EntryPoint): boolean {
  return clause.guardsParse && clause.tryStatementCount * 2 < ep.statementCount;
}

/**
 * Whether a clause has decided what the error means. Rethrowing is a decision, branching is a
 * decision, and guarding a parse answers for the one thing the guard covers.
 *
 * `narrow` is deliberately not a fourth way to qualify, which is where this differs from the rule
 * the scanner work proposed. A one-statement try around `await service.call(run)` is narrow and is
 * still a swallow. Taking the narrow limb clears eleven more entry points, and reading all eleven
 * says six are real: the silent cancel in `api.v2.runs.$runParam.cancel.ts`, the PAT revoke in
 * `account.tokens/route.tsx` and the invite revoke, both of which report a database failure to the
 * browser as a 400 with an internal message in it, a `.map` that drops a broken dashboard on the
 * floor, and two more. The four it would rightly clear are all the same deliberate shape, best
 * effort side work that logs and carries on, and all four are non-sensitive so they sort to the
 * bottom of the fix list. See the task 5 report; switching is one limb in this function.
 */
export function accountedFor(clause: CatchEvidence, ep: EntryPoint): boolean {
  return clause.rethrows || clause.branches || isParseGuard(clause, ep);
}

export function usesBuilder(ep: EntryPoint): boolean {
  return (
    (ep.loaderInitializerCallee !== null && BUILDERS.has(ep.loaderInitializerCallee)) ||
    (ep.actionInitializerCallee !== null && BUILDERS.has(ep.actionInitializerCallee))
  );
}

/**
 * Who decides what a failure means, and on what evidence.
 *
 * The swallow is read before the builder is credited, which looks like the wrong order until you
 * read `api.v2.runs.$runParam.cancel.ts`: a `createActionApiRoute` handler wrapping its service
 * call in `try { ... } catch { return 500 }`. The builder classifies what reaches it, and that
 * error never does. Crediting the wrapper would hide the one case in this family worth finding.
 *
 * Judged per catch clause, so an entry point is only as good as its worst one. That is the whole
 * point of the per-clause evidence: 39 routes have more than one catch and 17 mix a narrow guard
 * with a broad handler, and under the old aggregate booleans a single well-behaved catch spoke for
 * the swallow next to it.
 *
 * "Does this route catch anything" is `catches.length`, never `hasTryCatch`. A try/finally with no
 * catch leaves `hasTryCatch` true and `catches` empty: nothing is swallowed there, the error
 * propagates once the cleanup has run, and reading the old flag as a catch put
 * `admin.api.v1.runs-replication.status.ts` at the top of the first rendered fix list.
 */
export const errorClassification = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    const unaccounted = ep.catches.filter((c) => !accountedFor(c, ep));
    if (unaccounted.length > 0) {
      const which =
        ep.catches.length > 1 ? ` (${unaccounted.length} of ${ep.catches.length} catches)` : "";
      return {
        id: ID,
        status: "fail",
        detail: `catches its errors and takes one way out regardless of what was thrown${which}`,
      };
    }
    if (ep.catches.length > 0) {
      return { id: ID, status: "pass", detail: "every catch decides what it caught" };
    }
    if (usesBuilder(ep)) {
      return { id: ID, status: "pass", detail: "classified by the builder" };
    }
    return { id: ID, status: "pass", detail: "errors propagate to the global handler" };
  },
};
