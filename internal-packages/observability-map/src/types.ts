export type CheckStatus = "pass" | "fail" | "not-applicable";

export type CheckResult = {
  id: string;
  status: CheckStatus;
  detail?: string;
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
  /** Whether a `try` appears in the loader/action bodies, or in a same-file helper they call. */
  hasTryCatch: boolean;
  /**
   * Statement count across loader/action bodies, used by the triviality rule. A body that
   * delegates to a same-file helper counts that helper's statements too, one hop only: work in a
   * helper's own helpers, or in an imported module, is not counted.
   */
  statementCount: number;
};
