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
 * broad swallow as a narrow guard, moving the denominator without touching the clause at all. An
 * absolute count over the try block alone cannot be diluted by anything outside it.
 */
const NARROW_TRY_STATEMENTS = 2;

/**
 * Whether a catch clause is a guard rather than the route's error handling: it wraps a parse and
 * holds at most `NARROW_TRY_STATEMENTS`. Both halves matter. `guardsParse` alone lets
 * `otel.v1.logs.ts` off, whose catch covers 7 statements and merely happens to contain a
 * `request.json()`, and that is a real swallow; a validating zod `.safeParse` followed by an issue
 * check and a bespoke error response is real handling too, not a bind-and-return guard, and stays
 * excluded at three statements or more for the same reason.
 */
function isParseGuard(clause: CatchEvidence): boolean {
  return clause.guardsParse && clause.tryStatementCount <= NARROW_TRY_STATEMENTS;
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
