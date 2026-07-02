import type { RbacAbility, RbacResource } from "@trigger.dev/rbac";

/**
 * A single permission check, mirroring the `authorization` option the
 * dashboard/api route builders accept: either a super-user check or an
 * action + resource(s) pair.
 */
export type PermissionCheck =
  | { requireSuper: true }
  | { action: string; resource: RbacResource | RbacResource[] };

/**
 * Evaluate a set of permission checks against an already-resolved `ability`
 * and return a plain boolean map for the client to gate UI on.
 *
 * The matching lives entirely in the injected ability — permissive by
 * default, and fully enforced when an RBAC plugin is installed — so this only
 * calls `can`/`canSuper` and no permission-model logic lives here. The
 * returned booleans are display-only: the route builder's `authorization`
 * block is the real security boundary.
 */
export function canManageBillingLimits(ability: RbacAbility): boolean {
  return ability.can("manage", { type: "billing-limits" });
}

export function checkPermissions<K extends string>(
  ability: RbacAbility,
  checks: Record<K, PermissionCheck>
): Record<K, boolean> {
  const result = {} as Record<K, boolean>;
  for (const key in checks) {
    const check = checks[key];
    result[key] =
      "requireSuper" in check ? ability.canSuper() : ability.can(check.action, check.resource);
  }
  return result;
}
