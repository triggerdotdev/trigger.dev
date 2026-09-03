// Pure: no server-only imports, so a test can drive this without loading env.server.
/**
 * Which coordinator mints a NEW waitpoint. Consulted at the mint and never again: every
 * later operation routes by id shape. A flip therefore changes only where the NEXT
 * waitpoint is born, which is why this needs no flip-grace machinery.
 */
export type WaitpointMintKind = "legacy" | "store";

/** The flag's vocabulary, deliberately not the coordinator's. */
type WaitpointSystemFlag = "legacy" | "redis";

type MintKindDeps = {
  globalDefault: WaitpointSystemFlag;
  /** Undefined when the org has no override. Must not hit the DB when given org flags. */
  flag: (
    orgId: string,
    orgFeatureFlags: unknown | undefined
  ) => Promise<WaitpointSystemFlag | undefined>;
  /** Surfaced instead of logged, so this module pulls in no server-only import. */
  onError?: (error: unknown) => void;
};

// PURE CORE — no env import; the tests drive this directly.
export async function computeWaitpointMintKind(
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown },
  deps: MintKindDeps
): Promise<WaitpointMintKind> {
  try {
    const perOrg = await deps.flag(environment.organizationId, environment.orgFeatureFlags);
    return (perOrg ?? deps.globalDefault) === "redis" ? "store" : "legacy";
  } catch (error) {
    // Fail safe, as computeRunIdMintKind does: a flag-read failure degrades to the old
    // path rather than becoming a trigger-path outage.
    deps.onError?.(error);
    return "legacy";
  }
}
