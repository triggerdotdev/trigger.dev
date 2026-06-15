import type { RbacAbility } from "@trigger.dev/plugins";

// Scope-string interpretation is shared with any auth plugin via
// @trigger.dev/plugins so a public token decodes identically whoever
// serves the request. Re-exported here so existing importers keep their
// `./ability.js` import.
export { buildJwtAbility } from "@trigger.dev/plugins";

/** Every authenticated non-admin subject: can do anything, cannot do super-user actions. */
export const permissiveAbility: RbacAbility = {
  can: () => true,
  canSuper: () => false,
};

/** Platform admin (user.admin = true): can do everything including super-user actions. */
export const superAbility: RbacAbility = {
  can: () => true,
  canSuper: () => true,
};

/** Deprecated PUBLIC tokens and unauthenticated subjects: denied everything. */
export const denyAbility: RbacAbility = {
  can: () => false,
  canSuper: () => false,
};

export function buildFallbackAbility(isAdmin: boolean): RbacAbility {
  return isAdmin ? superAbility : permissiveAbility;
}
