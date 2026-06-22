import { type RuntimeEnvironmentType } from "@trigger.dev/database";

type BranchableEnvironmentInput = {
  type: RuntimeEnvironmentType;
  parentEnvironmentId: string | null;
  isBranchableEnvironment: boolean;
};

/**
 * Whether an environment is a branchable parent (i.e. branches can be created
 * under it), as opposed to a branch itself or a non-branchable environment.
 *
 * Branchability is split by type:
 * - A branch (any env with a `parentEnvironmentId`) is never itself branchable.
 * - DEVELOPMENT roots are always branchable — it's derivable from the structure,
 *   so we don't trust the `isBranchableEnvironment` column for dev.
 * - PREVIEW roots use the `isBranchableEnvironment` column, which is the
 *   long-standing source of truth (and may hold legacy non-branchable rows).
 * - STAGING / PRODUCTION are never branchable.
 *
 * The `parentEnvironmentId === null` guard is load-bearing: dev *branches* are
 * also `type === "DEVELOPMENT"`, so checking the type alone would misclassify
 * them. Always go through this helper rather than inlining the rule.
 */
export function isBranchableEnvironment(env: BranchableEnvironmentInput): boolean {
  if (env.parentEnvironmentId !== null) return false;
  if (env.type === "DEVELOPMENT") return true;
  if (env.type === "PREVIEW") return env.isBranchableEnvironment;
  return false;
}
