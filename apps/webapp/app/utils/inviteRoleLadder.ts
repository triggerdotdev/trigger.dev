// A user can only assign a role at or below their own — on invite, and on the
// Team page's role picker. The systemRoles array is in canonical order
// (highest authority first), so array index drives the ladder. Custom roles
// aren't in the table and are refused. Dependency-free so the rule can be
// unit-tested directly.

export type LadderRole = { id: string };

function buildRoleLevel(roles: ReadonlyArray<LadderRole>): Record<string, number> {
  const level: Record<string, number> = {};
  roles.forEach((r, i) => {
    // Top of the array = highest level; larger number means more authority.
    level[r.id] = roles.length - i;
  });
  return level;
}

/**
 * Whether an inviter holding `inviterRoleId` may assign `invitedRoleId`.
 * A roleless inviter (`inviterRoleId == null`) and custom/unknown roles absent
 * from the ladder are all refused.
 */
export function isAtOrBelow(
  roles: ReadonlyArray<LadderRole>,
  inviterRoleId: string | null,
  invitedRoleId: string
): boolean {
  if (!inviterRoleId) return false;
  const level = buildRoleLevel(roles);
  const inviter = level[inviterRoleId];
  const invited = level[invitedRoleId];
  if (inviter === undefined || invited === undefined) return false;
  return invited <= inviter;
}

/**
 * The subset of `roles` that a user holding `viewerRoleId` may assign, by the
 * ladder above. Knows nothing about plan gating: a role the org's plan does
 * not allow is still returned, so a caller that wants to surface it as an
 * upgrade affordance can. Callers that have no upgrade affordance intersect
 * with their plan-assignable set themselves.
 *
 * `systemRoles` is null when no RBAC plugin is installed — there is no ladder
 * to check against, so nothing is offerable.
 */
export function offerableRoleIds(
  roles: ReadonlyArray<LadderRole>,
  systemRoles: ReadonlyArray<LadderRole> | null,
  viewerRoleId: string | null
): string[] {
  if (!systemRoles) return [];
  return roles.filter((r) => isAtOrBelow(systemRoles, viewerRoleId, r.id)).map((r) => r.id);
}
