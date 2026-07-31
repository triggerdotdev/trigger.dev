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

/**
 * A parse: `await request.json()`, `JSON.parse(raw)`. The dot matters, it keeps Remix's `json({})`
 * response helper out. Matched against `calleeTexts`, which carries the whole callee path.
 */
const PARSE_CALL = /(^|\.)JSON\.parse$|\.json$/;

/**
 * Whether every catch in the entry point guards a parse and nothing wider. Both checks read the
 * field the same way: a guard around one parse is not the route taking charge of its failures,
 * so `error-classification` does not call it a swallow and `request-context` does not ask it to
 * name a tenant.
 */
export function guardsOnlyAParse(ep: EntryPoint): boolean {
  return ep.catchesNarrowly && ep.calleeTexts.some((t) => PARSE_CALL.test(t));
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
 * `catchRethrows` and `catchBranches` are OR-ed across every catch clause in the bodies, so both
 * false means every catch in the entry point takes the same way out whatever was thrown. The
 * asymmetry that buys: one good catch alongside one swallow reads as a pass. This check misses
 * those rather than inventing them.
 *
 * `catchesNarrowly` excuses the guard that wraps one operation and answers for that operation:
 * `try { body = await request.json() } catch { 400 }` neither branches nor rethrows and does not
 * need to. On its own it excuses too much, because a one-statement try around an awaited service
 * call is exactly as narrow as one around a parse: applied unencumbered it passes
 * `try { await service.call(run) } catch { 500 }`, and it passes the design's own swallow fixture,
 * `try { return await prisma.thing.findMany() } catch { return null }`. So the exemption also asks
 * that the body parse something, which is the idiom the exemption was justified by. Over the real
 * tree that combination clears the nine verbatim `request.json()` guards and holds back the four
 * hand-read findings, see the task 5 report.
 */
export const errorClassification = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    const guardsAParse = guardsOnlyAParse(ep);
    if (ep.hasTryCatch && !ep.catchRethrows && !ep.catchBranches && !guardsAParse) {
      return {
        id: ID,
        status: "fail",
        detail: "catches its errors and takes one way out regardless of what was thrown",
      };
    }
    if (guardsAParse) {
      return { id: ID, status: "pass", detail: "guards a parse, not the handler" };
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
