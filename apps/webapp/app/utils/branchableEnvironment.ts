import { type Prisma, type RuntimeEnvironmentType } from "@trigger.dev/database";

type BranchableEnvironmentInput = {
  type: RuntimeEnvironmentType;
  parentEnvironmentId: string | null;
  isBranchableEnvironment: boolean;
};

export type BranchableEnvironmentType = Extract<
  RuntimeEnvironmentType,
  "PREVIEW" | "DEVELOPMENT"
>;

/**
 * The wire/form token for a branchable environment kind, as sent by the CLI and
 * dashboard forms.
 */
export type BranchableEnvironmentToken = "preview" | "development";

export function toBranchableEnvironmentType(
  env: BranchableEnvironmentToken
): BranchableEnvironmentType {
  switch (env) {
    case "preview": return "PREVIEW";
    case "development": return "DEVELOPMENT";
  }
}

/**
 * Prisma `where` fragment matching the *root* environment of a type — the
 * branchable parent, never a branch (branches always carry a `parentEnvironmentId`).
 * DEVELOPMENT roots are per-org-member, so pass `userId` to disambiguate between
 * members' dev environments.
 *
 * Use this instead of locating roots by their magic slug (`"dev"` / `"preview"`),
 * which is an instance identifier, not a reliable type discriminator. Whether the
 * matched root is actually branchable is a separate concern — gate it with
 * {@link isBranchableEnvironment} after the lookup.
 */
export function rootEnvironmentWhere(
  type: RuntimeEnvironmentType,
  opts?: { userId?: string }
): Prisma.RuntimeEnvironmentWhereInput {
  return {
    type,
    parentEnvironmentId: null,
    ...(type === "DEVELOPMENT" && opts?.userId ? { orgMember: { userId: opts.userId } } : {}),
  };
}

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
