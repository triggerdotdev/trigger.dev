import type { CatchEvidence, CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";

const ID = "error-classification";

/**
 * The route builders that authenticate the request, which is what `auth-boundary` reads them for.
 * They also catch and classify, but `error-classification` does not credit that: a route with no
 * catch of its own is judged on nothing, wrapper or not.
 *
 * `createSSELoader` is deliberately absent. It turns a non-Response error into a 500 but does not
 * authenticate, so listing it would hand two routes a free `auth-boundary` pass.
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
 * How much a try block may guard and still count as narrow. Two, so the guarded operation can bind
 * its result (`const stripped = ...; new RegExp(stripped);`).
 *
 * An absolute count and not a ratio against the enclosing body, or padding the body relabels the
 * same broad swallow as a narrow guard (`inert-statements-after-try`). The count is NOT unpaddable,
 * which an earlier docstring claimed: it is one condition of three and no longer the load-bearing
 * one. See INTERNALS.md, "Parse guards, and the narrow-try count".
 */
const NARROW_TRY_STATEMENTS = 2;

/**
 * Whether a catch clause is a guard rather than the route's error handling: the try block parses,
 * waits for nothing except that parse, and is short.
 *
 * Two residuals, since awaiting is the signal rather than calling. A block that does its non-parse
 * work synchronously still reads as a guard, and `guardedWork` looks for a `ts.AwaitExpression`,
 * which `for await (...)` and `await using` are not. Neither occurs in the tree and neither is
 * reachable by rewriting a real route. Both are in the round A fix 3 report.
 */
function isParseGuard(clause: CatchEvidence): boolean {
  return (
    clause.guardsParse &&
    clause.awaitsOnlyParse &&
    clause.tryStatementCount <= NARROW_TRY_STATEMENTS
  );
}

/**
 * Whether a clause decides anything about the error it caught. Two ways to qualify: it branches, or
 * it guards a parse it can answer for. Rethrowing is not a third way, and neither is being narrow
 * without parsing.
 *
 * The cost is real and worth stating here: `catch (e) { logger.error(...); throw e }` reads as
 * inert too, because `CatchEvidence` cannot say whether a clause does anything besides rethrow.
 * That is the safe direction, since crediting it reopens the hole a bare `logger.error` line wide,
 * and `request-context` still reads that log and asks whether it names a tenant.
 */
function decides(clause: CatchEvidence): boolean {
  return clause.branches || isParseGuard(clause);
}

/** Passes the error through unchanged, which is the same outcome as not catching it. */
function inert(clause: CatchEvidence): boolean {
  return clause.rethrows && !decides(clause);
}

/** The error stops here and nothing chose what it meant. */
function swallows(clause: CatchEvidence): boolean {
  return !decides(clause) && !inert(clause);
}

/**
 * Who decides what a failure means, and on what evidence. Judged per catch clause, so an entry point
 * is only as good as its worst one.
 *
 * A route with no catch is not-applicable rather than a pass, and that takes the builder credit with
 * it. "Does this route catch anything" is `catches.length`, never `hasTryCatch`, because a
 * try/finally leaves the flag true and the list empty.
 *
 * The open hole a reader of this function has to know about: `guardCanRaise` refuses `try { 0; }`
 * and is defeated by one inert call, so `try { String(0); }` reads as classification and takes the
 * tree from 19 to 44. `dead-classifying-try-with-call` in the mutation corpus is that shape,
 * running as an expected failure. Read the rule as "refuses `try { 0; }`", never as "an unreachable
 * catch cannot be credited". Everything else here: INTERNALS.md, "The dead-code defence".
 */
export const errorClassification = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    const reachable = ep.catches.filter((c) => c.guardCanRaise);
    const swallowed = reachable.filter(swallows);
    if (swallowed.length > 0) {
      const which =
        reachable.length > 1 ? ` (${swallowed.length} of ${reachable.length} catches)` : "";
      // "One way out" is only true of a clause that never throws, so this reads `throws` and not
      // `rethrows`. 16 clauses in the tree would otherwise carry the wrong detail line.
      const everyWayOut = swallowed.every((c) => !c.throws);
      return {
        id: ID,
        status: "fail",
        detail: everyWayOut
          ? `catches its errors and takes one way out regardless of what was thrown${which}`
          : `catches its errors and chooses what to do without looking at what was thrown${which}`,
      };
    }
    // Deliberately NOT conditioned on `ep.catches.length === 0`: an own inert catch, which
    // `wrap-body-in-rethrow` adds to every route, must not lift a refused swallow out of the verdict
    // (`fails a per-item swallow even when the route owns an inert rethrow catch`). And read off
    // `ep.catches` under `guardMayRaise`, never `reachable`, since a deciding catch `canRaise`
    // cannot see still decides (`does not accuse a route that owns a catch of owning none`).
    const reachableCb = ep.callbackCatches.filter((c) => c.guardCanRaise);
    const ownDecides = ep.catches.some((c) => decides(c) && c.guardMayRaise);
    if (!ownDecides && reachableCb.some(swallows)) {
      return {
        id: ID,
        status: "fail",
        detail:
          "a catch inside an iteration callback swallows what it caught, and nothing the route owns decides",
      };
    }
    // The ceiling that keeps `dead-deciding-map` from minting a pass on the 261 catchless routes:
    // refused catches never reach the pass arm. Read off `ep.catches` and not `reachable`, since a
    // route that owns a catch owns one whether or not `canRaise` could see what it guarded.
    if (ep.catches.length === 0 && ep.callbackCatches.length > 0) {
      return {
        id: ID,
        status: "not-applicable",
        detail:
          "its only catches sit in iteration callbacks and none swallows, so the route itself classifies nothing",
      };
    }
    if (!reachable.some(decides)) {
      return {
        id: ID,
        status: "not-applicable",
        detail:
          reachable.length === 0
            ? ep.catches.length === 0
              ? "catches nothing, so it classifies nothing"
              : "guards nothing that can throw, so it classifies nothing"
            : "every catch rethrows and nothing else, so it classifies nothing",
      };
    }
    return { id: ID, status: "pass", detail: "every catch decides what it caught" };
  },
};
