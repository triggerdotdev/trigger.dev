// The system roles form a ladder: the systemRoles array is in canonical order
// (highest authority first), so array index gives each role a level. Roles the
// org defined itself are not in that array and have no level at all.
//
// Two callers read the ladder, and they treat a role with no level
// differently. The invite flow (`isAtOrBelow`) requires a level on both sides
// and refuses anything else. The Team page's role picker (`offerableRoleIds`)
// only removes what the ladder positively places above the viewer, so custom
// roles stay offerable. Dependency-free so both rules can be unit-tested
// directly.

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
 * Whether the ladder places `candidateRoleId` strictly above `viewerRoleId`.
 * Only ever true when both roles have a level: a custom role on either side
 * is not comparable, so it is never "above", and nothing is above a viewer
 * whose own role has no level.
 */
function isAbove(
  roles: ReadonlyArray<LadderRole>,
  viewerRoleId: string | null,
  candidateRoleId: string
): boolean {
  if (!viewerRoleId) return false;
  const level = buildRoleLevel(roles);
  const viewer = level[viewerRoleId];
  const candidate = level[candidateRoleId];
  if (viewer === undefined || candidate === undefined) return false;
  return candidate > viewer;
}

/**
 * The subset of `roles` to offer a user holding `viewerRoleId` in a role
 * picker. The narrowing is subtractive: a role is dropped only where the
 * ladder puts it strictly above the viewer — the case where picking it would
 * always be rejected. Everything the ladder can't place stays offerable:
 *
 * - org-defined custom roles, which have no level, are always offered;
 * - a viewer whose own role has no level (a custom role, or no role at all)
 *   is offered the whole catalogue, since narrowing to nothing would take
 *   away their ability to manage members entirely — a worse outcome than
 *   offering a role the server may go on to refuse.
 *
 * Knows nothing about plan gating: a role the org's plan does not allow is
 * still returned, so a caller that wants to surface it as an upgrade
 * affordance can. Callers with no upgrade affordance intersect with their
 * plan-assignable set themselves.
 *
 * `systemRoles` is null when no RBAC plugin is installed — with no ladder
 * there is nothing to narrow by, so `roles` comes back as-is.
 */
export function offerableRoleIds(
  roles: ReadonlyArray<LadderRole>,
  systemRoles: ReadonlyArray<LadderRole> | null,
  viewerRoleId: string | null
): string[] {
  if (!systemRoles) return roles.map((r) => r.id);
  return roles.filter((r) => !isAbove(systemRoles, viewerRoleId, r.id)).map((r) => r.id);
}
