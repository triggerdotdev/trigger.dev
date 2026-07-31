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
 * Who decides what a failure means. Three answers count as covered: the builder does it, the route
 * declines to interfere and the error reaches the global handler, or the route is trivial.
 *
 * The fourth answer is the finding: a route outside the builders that catches its own errors. What
 * that catch then does is the question the check would like to answer and cannot. `EntryPoint`
 * carries `hasTryCatch`, a body-scoped boolean, and nothing about the catch clause itself, so a
 * rethrow and a swallow look identical from here. Reading the shape of the catch out of `ep.source`
 * would mean matching the whole file, React component included, which is how a component's
 * try/catch ends up deciding a loader's verdict. Coarse and honest beats precise and wrong: the
 * check reports the hand-rolled catch and says it has not been read.
 */
export const errorClassification = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    if (usesBuilder(ep)) {
      return { id: ID, status: "pass", detail: "classified by the builder" };
    }
    if (!ep.hasTryCatch) {
      return { id: ID, status: "pass", detail: "errors propagate to the global handler" };
    }
    return {
      id: ID,
      status: "fail",
      detail:
        "handles its own errors outside a route builder, and the catch has not been read: check it distinguishes expected from unexpected",
    };
  },
};
