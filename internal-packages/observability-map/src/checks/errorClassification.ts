import type { CatchEvidence, CheckResult, EntryPoint } from "../types.js";
import { isTrivial } from "../triviality.js";

const ID = "error-classification";

/**
 * The route builders that authenticate the request, which is what `auth-boundary` reads them for.
 * They also catch and classify, passing a thrown `Response` through untouched and reporting
 * anything else through `logBoundaryError`, but `error-classification` no longer credits that: a
 * route with no catch of its own is judged on nothing, wrapper or not.
 *
 * `createSSELoader` is deliberately absent. It turns a non-Response error into a 500 but does not
 * authenticate, so counting it here would hand two routes a free pass on `auth-boundary`.
 * `createHybridActionApiRoute`, which the design named, exists nowhere in the tree.
 */
const BUILDERS = new Set([
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
 * its result (`const stripped = ...; new RegExp(stripped);`), but a third statement means the try
 * has started to cover the handler rather than one operation. The idiom this was chosen for and
 * hand-read against originally: 55 of 427 entry points, 11 of the failures at the time, all eleven
 * the deliberate `try { body = await request.json() } catch { 400 }` shape.
 *
 * An absolute count, not a ratio against the enclosing body. A ratio is diluted by anything else in
 * the same body: padding the action with unrelated statements after the try relabelled the same
 * broad swallow as a narrow guard, moving the denominator without touching the clause at all.
 * `inert-statements-after-try` in the mutation corpus is that shape, and it holds.
 *
 * What the count is NOT is unpaddable, which an earlier docstring and commit subject both claimed.
 * `countStatement` now counts declarators and comma operands rather than semicolons, so the two
 * known ways to pack a try into fewer statements move the number the same as writing it out; that
 * is what `merge-declarations` and `merge-comma-expressions` in the corpus check. A third
 * way nobody has written down would work, which is why the count is no longer the only condition
 * and no longer the load-bearing one.
 */
const NARROW_TRY_STATEMENTS = 2;

/**
 * Whether a catch clause is a guard rather than the route's error handling: the try block parses,
 * waits for nothing except that parse, and is short.
 *
 * `awaitsOnlyParse` is the condition the previous wave was missing, and it is the one a statement
 * count cannot express. `try { const body = await request.json(); return await handleEverything(body); }
 * catch { return 500; }` is two statements, one of them a parse, and the whole handler inside it:
 * the count reads it as narrow and it is the `otel.v1.logs.ts` swallow written compactly. Asking
 * what the block waits for separates them, and unlike the count it does not care how the statements
 * are punctuated or how deeply the work is nested inside one of them.
 *
 * The design's own suggestion, requiring the clause to answer with a 4xx, was measured first and is
 * not used. On its own it credits 11 clauses guarding four to thirty statements, the widest swallows
 * in the tree, including `admin.api.v1.workers.ts`, whose 28-statement try answers every failure
 * with a 400 carrying the internal error message. Added on top it costs three routes their pass,
 * all three narrow parse guards that compute a fallback value rather than answering a request
 * (`try { return new URL(referer).origin; } catch { return undefined; }`), and it buys only the case
 * of a narrow parse guard answering 500. Requiring every CALL to be a parse, rather than every
 * await, was measured too and is worse still: it refuses the four `matchPattern.slice(4); new
 * RegExp(...)` guards, because preparing a parse's input is ordinary synchronous string work.
 *
 * The residual, since awaiting is the signal: a try block that does its non-parse work
 * synchronously still reads as a guard. Nothing in the tree does, and it is written down in the
 * round A fix 2 report rather than defended.
 */
function isParseGuard(clause: CatchEvidence): boolean {
  return (
    clause.guardsParse &&
    clause.awaitsOnlyParse &&
    clause.tryStatementCount <= NARROW_TRY_STATEMENTS
  );
}

/**
 * Whether a clause decides anything about the error it caught. Two ways to qualify: it branches, on
 * an `if`, a `switch` or an `instanceof`, or it guards a parse it can answer for.
 *
 * Rethrowing is not a third way, which is the correction from the last wave. A clause whose only
 * effect is `throw e` leaves the error propagating exactly as it would with no catch at all, so
 * treating that as a pass while no catch is not-applicable paid 50 points a route for wrapping a
 * body in `try { ... } catch (e) { throw e }`, and 27 across the tree. The two are observationally
 * identical and are now scored identically.
 *
 * The cost is real and worth stating: `catch (e) { logger.error(...); throw e }` also reads as
 * inert, because `CatchEvidence` cannot say whether a clause does anything besides rethrow. That
 * withholds credit from a route that reports before propagating, which is the safe direction to be
 * wrong in, since crediting it would reopen the hole a bare `logger.error` line wide.
 * `request-context` still reads that log and asks whether it names a tenant, so the reporting is
 * unrewarded here rather than unmeasured.
 *
 * A narrow guard is not a way to qualify either. A one-statement try around `await
 * service.call(run)` is narrow and is still a swallow: reading all eleven entry points that limb
 * would clear said six were real, including a silent run cancellation and two credential paths
 * that report a database failure to the browser as a 400 with an internal message in it.
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

export function usesBuilder(ep: EntryPoint): boolean {
  return (
    (ep.loaderInitializerCallee !== null && BUILDERS.has(ep.loaderInitializerCallee)) ||
    (ep.actionInitializerCallee !== null && BUILDERS.has(ep.actionInitializerCallee))
  );
}

/**
 * Who decides what a failure means, and on what evidence.
 *
 * Judged per catch clause, so an entry point is only as good as its worst one. That is the point of
 * the per-clause evidence: 39 routes have more than one catch and 17 mix a narrow guard with a
 * broad handler, and under the old aggregate booleans a single well-behaved catch spoke for the
 * swallow next to it.
 *
 * A route with no catch is not-applicable, not a pass. It makes no classification decision, so
 * there is nothing here to judge and nothing to credit. Crediting it was worse than merely
 * generous: with `request-context` also passing the same routes, emptying every catch clause in the
 * tree scored it 100, so the metric paid you for deleting error handling. Out of the denominator
 * is the honest place for it, and it takes the builder credit with it: a builder-wrapped route with
 * no catch of its own now sits out too, rather than collecting a point for the wrapper.
 *
 * "Does this route catch anything" is `catches.length`, never `hasTryCatch`. A try/finally with no
 * catch leaves `hasTryCatch` true and `catches` empty: nothing is swallowed there, the error
 * propagates once the cleanup has run, and reading the old flag as a catch put
 * `admin.api.v1.runs-replication.status.ts` at the top of the first rendered fix list.
 *
 * `callbackCatches` is the third case, and it is what stops "no catch is not-applicable" from being
 * a payout. A route whose catches all sat inside a callback the scanner refused to attribute has
 * error handling, the scanner just could not read it as the route's; excusing that is worth 50
 * points to anyone who wraps a body in something the boundary rule refuses, which
 * `Promise.all([0].map(async () => { ... }))` did. It fails instead. The precision cost is a route
 * that genuinely only handles errors per item, which now fails rather than sitting out.
 */
export const errorClassification = {
  id: ID,
  run(ep: EntryPoint): CheckResult {
    if (isTrivial(ep)) {
      return { id: ID, status: "not-applicable", detail: "trivial route" };
    }
    const swallowed = ep.catches.filter(swallows);
    if (swallowed.length > 0) {
      const which =
        ep.catches.length > 1 ? ` (${swallowed.length} of ${ep.catches.length} catches)` : "";
      return {
        id: ID,
        status: "fail",
        detail: `catches its errors and takes one way out regardless of what was thrown${which}`,
      };
    }
    if (ep.catches.length === 0 && ep.callbackCatches > 0) {
      return {
        id: ID,
        status: "fail",
        detail: "its only error handling sits in a callback the route does not own",
      };
    }
    if (!ep.catches.some(decides)) {
      return {
        id: ID,
        status: "not-applicable",
        detail:
          ep.catches.length === 0
            ? "catches nothing, so it classifies nothing"
            : "every catch rethrows and nothing else, so it classifies nothing",
      };
    }
    return { id: ID, status: "pass", detail: "every catch decides what it caught" };
  },
};
