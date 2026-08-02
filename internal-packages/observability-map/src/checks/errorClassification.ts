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
 * Two residuals, since awaiting is the signal. A try block that does its non-parse work
 * synchronously still reads as a guard. And `guardedWork` looks for a `ts.AwaitExpression`, which
 * `for await (const chunk of work(await request.json()))` and `await using` are not, so a block
 * whose only non-parse work is one of those reads as a guard too. Neither occurs in the tree and
 * neither is reachable by rewriting a real route, since both need work that is not there to begin
 * with. Both are in the round A fix 3 report.
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
 * a payout. A refused catch is judged on its evidence, never on its placement: the same
 * `catchClauseEvidence` an own catch gets, with two arms reading it. A refused swallow fails the
 * route whenever nothing the route owns decides, and that arm is deliberately not conditioned on
 * the route owning no catches, so an own inert rethrow catch cannot lift a refused swallow out of
 * the verdict (`fails a per-item swallow even when the route owns an inert rethrow catch`). A
 * route whose only catches are refused and none of them swallows sits out, and never passes: the
 * not-applicable ceiling is what keeps a prepended dead deciding `.map` from minting a pass on the
 * 261 catchless routes, which `dead-deciding-map` in the mutation corpus holds at tree scale and
 * `sits out a catchless route with a prepended dead deciding map` pins on a fixture. What the old
 * blanket placement rule blocked, relocating a swallow behind the boundary, still fails
 * (`still fails a swallow wrapped in a non-array receiver's .map(...)`); what it wrongly accused,
 * a route whose only error handling genuinely is per item, now sits out instead of failing
 * (`sits out a route whose only catch is a deciding per-item boundary`).
 *
 * A clause whose try block holds nothing that could raise is read as no clause at all,
 * `guardCanRaise` on the evidence. Prepending `try { 0; } catch (e) { if (e instanceof Error) {
 * return json(x, { status: 400 }); } throw e; }` to every body takes the tree from 19 to 44 and
 * raised 224 routes, because the 261 routes that catch nothing were sitting at not-applicable and a
 * dead clause moved each of them to pass.
 *
 * What that refuses is `try { 0; }`, and it is defeated by one inert call: `try { String(0); }`
 * reads as classification and pays the same 224 routes, because `canRaise` accepts any call at all.
 * The rule closes the shape that was found, not the family, and telling an inert call from a
 * throwing one needs types the scanner does not have. `dead-classifying-try-with-call` in the
 * mutation corpus is the open shape, running as an expected failure.
 *
 * The refused-swallow arm reads the route's own deciding catches through `guardMayRaise`, never
 * through `guardCanRaise`. `canRaise` is a whitelist and misses real raising code (a destructuring
 * declaration is not on its list, and `const { a } = undefined` throws), so ordering the arm off
 * `reachable` accused a route that owns a real classifying catch of owning none, which was simply
 * untrue; `does not accuse a route that owns a catch of owning none` pins the verdict. The
 * containment read `guardMayRaise` is false only for the provably-inert `try { 0; }`, so the one
 * clause that must not block the accusation, the prepended dead classifier `dead-classifying-try`
 * refuses, still does not block it (`still fails a per-item swallow beside a deciding catch over a
 * dead guard`). The already-open residual is unchanged: `try { String(0); }` reads as may-raise
 * AND can-raise, which is `dead-classifying-try-with-call`, the corpus's expected failure.
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
      // "One way out" is only true of a clause that never throws. A clause holding a `throw` that
      // is not its only exit is a swallow by this check's definition (it decides nothing about the
      // error) and it is NOT one way out, so saying so was a false accusation. 16 clauses in the
      // tree changed `rethrows` from true to false this round and every one of them would have
      // been eligible for it.
      const everyWayOut = swallowed.every((c) => !c.throws);
      return {
        id: ID,
        status: "fail",
        detail: everyWayOut
          ? `catches its errors and takes one way out regardless of what was thrown${which}`
          : `catches its errors and chooses what to do without looking at what was thrown${which}`,
      };
    }
    // A refused (iteration-callback) catch is judged on its evidence, never on its placement.
    // The fail arm first: a refused swallow fails whenever nothing the route owns decides.
    // Deliberately NOT conditioned on `ep.catches.length === 0`: an own inert catch, which
    // `wrap-body-in-rethrow` adds to every route, must not lift a refused swallow out of the
    // verdict, or wrapping a per-item-swallow route in try/rethrow reads "every catch rethrows".
    // `fails a per-item swallow even when the route owns an inert rethrow catch` pins that.
    // "Nothing the route owns decides" is read off `ep.catches` under `guardMayRaise`, not off
    // `reachable`: a deciding catch `canRaise` cannot see still decides, and only the
    // provably-inert `try { 0; }` guard is excluded. See the `guardMayRaise` paragraph above.
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
    // The ceiling: refused catches never reach the pass arm, so a route whose only catches are
    // refused and none of them swallows sits out of the denominator rather than collecting
    // anything. Read off `ep.catches`, not `reachable`: a route that owns a catch owns one,
    // whether or not `canRaise` could see what it guarded; ordering this off `reachable` turned
    // every `canRaise` miss on a route that also has a per-item catch into an accusation that was
    // flatly false. The detail asserts nothing about ownership or per-item-ness the scanner
    // cannot know: a once-invoked Result-style wrapper with a deciding inner catch reads the same
    // as its inline equivalent would.
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
