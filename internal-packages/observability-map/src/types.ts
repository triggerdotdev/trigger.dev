type CheckStatus = "pass" | "fail" | "not-applicable";

export type CheckResult = {
  id: string;
  status: CheckStatus;
  detail?: string;
};

/**
 * One catch clause in a loader/action body, or in a same-file helper the body calls. Per clause
 * rather than per entry point, so a narrow parse guard sitting beside a broad handler catch stays
 * legible. Every field's exact rule and its measured reasoning: INTERNALS.md, "Catch evidence, per
 * clause".
 */
export type CatchEvidence = {
  /** Throwing is the clause's only way out: a throw on the clause's guaranteed path (see
   * `catchClauseEvidence`) and no live `return` anywhere. */
  rethrows: boolean;
  /** A throw is reached on that path, whether or not it is the only way out. Kept apart from
   * `rethrows` so a verdict can say what is true of a clause that both throws and returns. */
  throws: boolean;
  /** The clause picks what to do from what it caught, on that same guaranteed path. */
  branches: boolean;
  /** The guarded region parses something. Includes `new URL`/`URLSearchParams`/`RegExp`, which the
   * call-callee scan cannot see because a `new` expression is not a call. */
  guardsParse: boolean;
  /** The guarded region does anything that could raise. Any call counts, including one that cannot
   * throw, so `try { String(0); }` is true here: `dead-classifying-try-with-call`. */
  guardCanRaise: boolean;
  /**
   * The containment twin of `guardCanRaise`: false only for the provably inert `try { 0; }`, so
   * can-raise implies may-raise. Read by the refused-callback arm of `error-classification`, where
   * a `canRaise` miss would otherwise accuse a route that owns a real classifying catch
   * (`does not accuse a route that owns a catch of owning none`).
   */
  guardMayRaise: boolean;
  /** Everything the guarded region waits for is one of those parses. Synchronous work is not
   * counted: preparing a parse's input is synchronous, and the swallows this separates out wait on
   * a service. */
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

/**
 * Body-scoped evidence for one route module. Which fields are per export and why, and what "the
 * body" means: INTERNALS.md, "How the scanner reads a route".
 */
export type EntryPoint = {
  fileName: string;
  source: string;
  hasLoader: boolean;
  hasAction: boolean;
  /** Callee name when `loader`/`action` is assigned from a call, e.g. a route builder. */
  loaderInitializerCallee: string | null;
  actionInitializerCallee: string | null;
  /** Top-level keys of the object literals passed to that call. Empty means "nothing declared
   * here" rather than "no builder". */
  loaderBuilderOptions: string[];
  actionBuilderOptions: string[];
  /**
   * The route declares a loader or an action and the scan resolved neither a handler function nor a
   * builder call for any of them, so nothing about the request handling is in this file. A route
   * that delegates ONE export and writes the other in the file is not delegating by this
   * definition, and is judged on the half that is visible.
   */
  delegating: boolean;
  /** Whether THIS export's handler assigns the caller's own id to an object-literal property.
   * Property assignments only, so a value read into a local first is not seen. */
  loaderScopesByCaller: boolean;
  actionScopesByCaller: boolean;
  /**
   * Callees whose answer THIS export's handlers demonstrably looked at: bound to a local, and that
   * local read by some condition. No entry-point-wide version exists on purpose, so no check can
   * let a loader's reading of `getUser` speak for the action beside it.
   *
   * Deliberately coarse: it does not check that the test guards anything, so a route writing
   * `if (!user) { logger.warn("anonymous"); }` and carrying on is credited.
   */
  loaderCheckedCallees: string[];
  actionCheckedCallees: string[];
  /** Named and default imports, file-wide. */
  importedNames: string[];
  /**
   * Names of functions called inside the loader/action bodies, or in a same-file helper they call.
   * Entry-point-wide, and read only by the questions that are themselves entry-point-wide. A
   * question about ONE export's exposure must read the pair below: `auth-boundary` read this and
   * credited a file whose loader called a guard for an action that called none.
   */
  calleeNames: string[];
  /** The same names attributed to the export whose handlers made the call. A handler serving both
   * exports contributes to both. */
  loaderCalleeNames: string[];
  actionCalleeNames: string[];
  /** The same calls as whole dotted paths (`prisma.organization.findFirst`), which the per-export
   * triviality rule needs to know a short body reaches the datastore. */
  loaderCalleeTexts: string[];
  actionCalleeTexts: string[];
  /** Whether a `try` appears in those bodies. A `try`/`finally` sets this while `catches` stays
   * empty, so ask `catches.length` whether anything is caught. */
  hasTryCatch: boolean;
  /** The same fact for one export's handlers alone. Read by the per-export triviality rule. */
  loaderHasTryCatch: boolean;
  actionHasTryCatch: boolean;
  /** One entry per catch clause in those bodies, in source order. */
  catches: CatchEvidence[];
  /**
   * Catch clauses the scan refused to attribute to the route because they sit inside a per-item
   * iteration callback. Never join `catches`, never speak for `tryStatementCount`, never reach a
   * pass. Kept WITH their evidence so `error-classification` can judge what a refused catch does
   * rather than where it sits.
   */
  callbackCatches: CatchEvidence[];
  /** Calls to a `logger.*` or `log.*` callee in those bodies, in source order. */
  logCalls: LogCall[];
  /** Statement count across loader/action bodies, used by the triviality rule. */
  statementCount: number;
  /** The same count for one export's handlers alone. A handler serving both exports is counted in
   * each, so these do not sum to `statementCount`. */
  loaderStatementCount: number;
  actionStatementCount: number;
};
