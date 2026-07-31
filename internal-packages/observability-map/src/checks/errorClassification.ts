import type { CheckResult, EntryPoint } from "../types.js";
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
 * `catchRethrows` and `catchBranches` are OR-ed across every catch clause in the bodies, so both
 * false means every catch in the entry point takes the same way out whatever was thrown. The
 * asymmetry that buys: one good catch alongside one swallow reads as a pass. This check misses
 * those rather than inventing them.
 */
export const errorClassification = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    if (ep.hasTryCatch && !ep.catchRethrows && !ep.catchBranches) {
      return {
        id: ID,
        status: "fail",
        detail: "catches its errors and takes one way out regardless of what was thrown",
      };
    }
    if (ep.catchRethrows || ep.catchBranches) {
      return { id: ID, status: "pass", detail: "the catch distinguishes what it caught" };
    }
    if (usesBuilder(ep)) {
      return { id: ID, status: "pass", detail: "classified by the builder" };
    }
    return { id: ID, status: "pass", detail: "errors propagate to the global handler" };
  },
};
