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
  /** The guarded try block holds at most two statements: one operation, not the handler. */
  narrow: boolean;
  /** The clause contains a `throw`. */
  rethrows: boolean;
  /** The clause branches on the error: an `if`, a `switch`, or an `instanceof`. */
  branches: boolean;
  /**
   * The guarded region parses or constructs something: `JSON.parse`, `request.json()`, a zod
   * `parse`/`safeParse`, or any `new X(...)`. Constructors are counted here because `new URL(x)` is
   * the commonest parse guard in the tree and constructors never appear in `calleeTexts`.
   */
  guardsParse: boolean;
  /** Statements in the guarded try block, counted as `statementCount` counts them. */
  tryStatementCount: number;
};

/** A logging call made from a loader/action body, or from a same-file helper the body calls. */
export type LogCall = {
  /** Full callee path, e.g. `logger.error`. */
  callee: string;
  /** Whether an object literal was passed as an argument. */
  hasObjectArgument: boolean;
  /** Property names on that object literal, e.g. `["environmentId", "error"]`. */
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
   * The same calls as `calleeNames`, same order and same length, but as the whole callee path:
   * `prisma.organization.findFirst` where `calleeNames` has `findFirst`. A path that runs through
   * something unnameable (`new PromptService().createOverride`) falls back to the bare name.
   */
  calleeTexts: string[];
  /**
   * Whether a `try` appears in the loader/action bodies, or in a same-file helper they call. Note
   * that this says a `try`, not a catch: a `try`/`finally` sets it while `catches` stays empty and
   * every catch-shaped field stays false. Read `catches.length` to ask whether anything is caught.
   */
  hasTryCatch: boolean;
  /** One entry per catch clause in those bodies, in source order. */
  catches: CatchEvidence[];
  /**
   * Whether any catch clause in those bodies contains a `throw`. A catch that rethrows has decided
   * the error is not its to answer, which is a different act from swallowing it. Aggregate of
   * `catches`, kept so existing consumers keep working.
   */
  catchRethrows: boolean;
  /**
   * Whether any catch clause in those bodies branches on the error: an `if`, a `switch`, or an
   * `instanceof`. With `catchRethrows` both false while `hasTryCatch` is true, every catch in the
   * entry point takes one path out regardless of what was thrown.
   */
  catchBranches: boolean;
  /**
   * Whether every catch in those bodies guards a specific operation rather than the handler: the
   * entry point has at least one catch clause, and no try block with a catch holds more than two
   * statements. The `try { body = await request.json() } catch { 400 }` idiom, which takes one path
   * out and is still deliberate. False when any catch wraps the bulk of a body, and false when
   * there is no catch clause at all.
   */
  catchesNarrowly: boolean;
  /** Calls to a `logger.*` or `log.*` callee in those bodies, in source order. */
  logCalls: LogCall[];
  /**
   * Statement count across loader/action bodies, used by the triviality rule. A body that
   * delegates to a same-file helper counts that helper's statements too, one hop only: work in a
   * helper's own helpers, or in an imported module, is not counted.
   */
  statementCount: number;
};
