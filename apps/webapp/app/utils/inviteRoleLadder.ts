// An inviter can only assign a role at or below their own. The systemRoles
// array is in canonical order (highest authority first), so array index drives
// the ladder. Custom roles aren't in the table and are refused. Dependency-free
// so the rule can be unit-tested directly.

export type LadderRole = { id: string };

export function buildRoleLevel(roles: ReadonlyArray<LadderRole>): Record<string, number> {
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
