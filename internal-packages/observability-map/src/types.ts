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
  /** Names of functions called inside the loader/action bodies. */
  calleeNames: string[];
  /** Whether a `try` appears inside the loader/action bodies. */
  hasTryCatch: boolean;
  /** Statement count across loader/action bodies, used by the triviality rule. */
  statementCount: number;
};
