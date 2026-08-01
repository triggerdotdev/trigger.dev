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
  /** The clause contains a `throw`. */
  rethrows: boolean;
  /**
   * The clause picks what to do from what it caught: an `if` or `switch` whose condition references
   * the caught error binding, or a conditional that is the whole `return`/`throw`. `if (retries > 0)`
   * does not count, and a bindingless `catch { ... }` cannot count at all. An `instanceof` used only
   * to word a message, `json({ error: e instanceof Error ? e.message : String(e) })`, does not
   * count either: every error still leaves by the same path.
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
  /** Calls to a `logger.*` or `log.*` callee in those bodies, in source order. */
  logCalls: LogCall[];
  /**
   * Statement count across loader/action bodies, used by the triviality rule. A body that
   * delegates to a same-file helper counts that helper's statements too, one hop only: work in a
   * helper's own helpers, or in an imported module, is not counted.
   */
  statementCount: number;
};
