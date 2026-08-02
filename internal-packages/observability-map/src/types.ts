export type CheckStatus = "pass" | "fail" | "not-applicable";

export type CheckResult = {
  id: string;
  status: CheckStatus;
  detail?: string;
};

/**
 * One catch clause in a loader/action body, or in a same-file helper the body calls. Per clause
 * rather than per entry point, so a narrow parse guard sitting beside a broad handler catch stays
 * legible instead of collapsing into one boolean.
 */
export type CatchEvidence = {
  /**
   * Throwing is the clause's only way out. Two conditions: a `throw` is reached on the clause's
   * guaranteed path (the positions certain to execute whenever the clause runs: its own
   * statements, a bare nested block's, a `do` body's, a catchless `try`'s tryBlock, a
   * single-default `switch`'s clause, an `if (true)` then-arm, and both arms of an `if`/`else`
   * together, cut at the first statement that definitely exits, see `catchClauseEvidence` and
   * `definitelyExits`), and the clause contains no live `return` anywhere. A throw guarded by a
   * condition the walk cannot fold, a loop, a nested caught `try`, a finally block or a callback
   * does not count, and neither does one written after something that has already returned.
   */
  rethrows: boolean;
  /** A `throw` is reached on that same guaranteed path, whether or not it is the only way out.
   * `rethrows` is this AND no reachable `return`. Kept separately so a verdict can say what is true
   * of a clause that both throws and returns. */
  throws: boolean;
  /**
   * The clause picks what to do from what it caught, on that same guaranteed path: an `if` or
   * `switch` whose condition references the caught error binding AND at least one of whose arms
   * returns or throws, or a conditional that is the whole value of a `return`/`throw`.
   * `if (retries > 0)` does not count, `if (e instanceof Error) { }` does not count, and a
   * bindingless `catch { ... }` cannot count at all. An `instanceof` used only to word a message,
   * `json({ error: e instanceof Error ? e.message : String(e) })`, does not count either: every
   * error still leaves by the same path.
   */
  branches: boolean;
  /**
   * The guarded region parses something: `JSON.parse`, `request.json()`, a zod `parse`/`safeParse`,
   * a `decode`, or a `new URL`/`URLSearchParams`/`RegExp`. Those three constructors are read here
   * because a `new` expression is not a call, so the call-callee scan that feeds this check never
   * sees them; other constructors do not count, or every `new SomePresenter()` in a try would excuse
   * its catch.
   */
  guardsParse: boolean;
  /**
   * The guarded region does something that could raise at all: a call, a construction, an `await`,
   * a member access, a `throw`, an iteration, an `instanceof`. False means `try { 0; }` and little
   * else: any call counts, including one that cannot throw, so `try { String(0); }` reads as true.
   * See `canRaise` in `scan.ts` for both directions of that, including the destructuring
   * declaration it misses.
   */
  guardCanRaise: boolean;
  /**
   * Everything the guarded region waits for is one of those parses. What separates
   * `try { const body = await request.json(); } catch { 400 }` from
   * `try { const body = await request.json(); return await handleEverything(body); } catch { 500 }`,
   * which the statement count reads as the same size. Synchronous work is not counted here: the
   * calls that prepare a parse's input are synchronous, and the swallows this has to catch wait on
   * a service.
   */
  awaitsOnlyParse: boolean;
  /** Statements in the guarded try block, counted as `statementCount` counts them. */
  tryStatementCount: number;
};

/** A logging call made from a loader/action body, or from a same-file helper the body calls. */
export type LogCall = {
  /** Full callee path, e.g. `logger.error`. */
  callee: string;
  /** Property names on the first object-literal argument, e.g. `["environmentId", "error"]`. */
  fields: string[];
  /** Whether the call sits inside a catch clause, i.e. on the failure path. */
  inCatch: boolean;
};

export type EntryPoint = {
  fileName: string;
  source: string;
  hasLoader: boolean;
  hasAction: boolean;
  /** Callee name when `loader`/`action` is assigned from a call, e.g. a route builder. */
  loaderInitializerCallee: string | null;
  actionInitializerCallee: string | null;
  /**
   * Top-level keys of the object literals passed to that call, e.g. `["params", "authorization"]`.
   * Empty when the export has no initializer call, and empty when the call takes no object
   * literal, so an empty array is "nothing declared here" rather than "no builder".
   */
  loaderBuilderOptions: string[];
  actionBuilderOptions: string[];
  /**
   * The route declares a loader or an action, and the scan resolved neither a handler function nor
   * a builder call for any of them: `export { action } from "./handler.server"`,
   * `export const action = handleWebhook`. Nothing about the request handling is in this file, so
   * every check reports not-applicable and `buildReport` counts the entry point separately from
   * the ones nothing happened to apply to. Those are different facts: a redirect stub genuinely has
   * nothing to instrument, a delegating route has work the scanner cannot see.
   *
   * A route that delegates one export and writes the other in the file is NOT delegating by this
   * definition, and is judged on the half that is visible.
   */
  delegating: boolean;
  /**
   * Whether THIS export's handler assigns the caller's own id to an object-literal property, the
   * `where: { members: { some: { userId: authentication.userId } } }` and
   * `presenter.call({ userId: user.id })` shapes. Read by `auth-scope` as evidence that the handler
   * narrowed its work to whoever is asking. See `CALLER_ID_PATH` and `scopesByCallerIn` in
   * `scan.ts`.
   *
   * Split per export because the exposure is per export: a loader that narrows itself to the caller
   * says nothing about the action beside it. Property assignments only, so a value read into a
   * local first (`const userId = user.id; ... { userId }`) is not seen.
   */
  loaderScopesByCaller: boolean;
  actionScopesByCaller: boolean;
  /**
   * Callees whose answer the body demonstrably looked at: the call's result was bound to a local
   * and some `if`, `while`, `switch` or conditional in the same bodies reads that local.
   * `const user = await getUser(request); if (!user) return redirect("/login");` puts `getUser`
   * here; a call whose result is dropped, or bound and never tested, does not appear.
   *
   * Read by `auth-boundary` for the guards that answer with null instead of throwing, where being
   * called is not evidence that the route acted on the answer.
   *
   * Deliberately coarse. It does not check that the test guards anything, that the local is the one
   * tested rather than a same-named one in another scope, or that the branch exits: a route
   * that writes `if (!user) { logger.warn("anonymous"); }` and carries on is credited. It separates
   * "looked at the answer" from "ignored it", which is the distinction the check needs, and not
   * "acted correctly on the answer", which it cannot see.
   */
  checkedCallees: string[];
  /** Named and default imports, file-wide. */
  importedNames: string[];
  /** Names of functions called inside the loader/action bodies, or in a same-file helper they call. */
  calleeNames: string[];
  /**
   * Whether a `try` appears in the loader/action bodies, or in a same-file helper they call. Note
   * that this says a `try`, not a catch: a `try`/`finally` sets it while `catches` stays empty and
   * every catch-shaped field stays false. Read `catches.length` to ask whether anything is caught.
   */
  hasTryCatch: boolean;
  /** One entry per catch clause in those bodies, in source order. */
  catches: CatchEvidence[];
  /**
   * Catch clauses the scan found but refused to attribute to the route, because they sit inside a
   * per-item iteration callback. Still refused for attribution: they never join `catches`, never
   * speak for the route's `tryStatementCount`, and never reach a pass. Kept WITH their evidence,
   * built by the same `catchClauseEvidence` machinery as an own catch, so `error-classification`
   * can judge what a refused catch does rather than where it sits: a refused swallow fails the
   * route (`fails a per-item swallow even when the route owns an inert rethrow catch`), a refused
   * catch that decides or rethrows caps at not-applicable (`sits out a route whose only catch is a
   * deciding per-item boundary`). The count the old field carried is `.length`.
   */
  callbackCatches: CatchEvidence[];
  /** Calls to a `logger.*` or `log.*` callee in those bodies, in source order. */
  logCalls: LogCall[];
  /**
   * Statement count across loader/action bodies, used by the triviality rule. Includes the
   * statements of functions written inline in those bodies, so wrapping a body in a callback does
   * not shrink it. A body that delegates to a same-file helper counts that helper's statements too,
   * one hop only: work in a helper's own helpers, or in an imported module, is not counted.
   */
  statementCount: number;
};
