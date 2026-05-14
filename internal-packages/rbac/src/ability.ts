import type { RbacAbility, RbacResource } from "@trigger.dev/plugins";

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

/** Builds an ability from JWT scope strings like "read:runs", "read:runs:run_abc", "read:all", "admin". */
export function buildJwtAbility(scopes: string[]): RbacAbility {
  const matches = (action: string, r: RbacResource): boolean =>
    scopes.some((scope) => {
      // Only the first two colons are delimiters — everything after the
      // second colon is the resource id (which may itself contain colons,
      // e.g. user-provided tags like "env:staging"). Naive
      // `split(":")` + 3-tuple destructuring truncated such ids to the
      // first segment and silently failed to match.
      const parts = scope.split(":");
      const scopeAction = parts[0];
      const scopeType = parts[1];
      const scopeId = parts.length > 2 ? parts.slice(2).join(":") : undefined;
      // Bare `admin` is the universal wildcard. `admin:<type>` is *not* —
      // it falls through to normal matching as action="admin" against
      // resources of that type. Pre-RBAC, the legacy checkAuthorization
      // string-matched superScopes; `admin:sessions` only granted access
      // to routes that explicitly listed it. Treating `admin:<anything>`
      // as universal here would silently broaden any such tokens.
      if (scopeAction === "admin" && !scopeType) return true;
      if (scopeAction !== action && scopeAction !== "*") return false;
      if (scopeType === "all") return true;
      if (scopeType !== r.type) return false;
      if (!scopeId) return true;
      return scopeId === r.id;
    });
  return {
    can(action: string, resource: RbacResource | RbacResource[]): boolean {
      // Array form means "any element passes → authorized", matching the
      // legacy multi-key checkAuthorization semantic.
      return Array.isArray(resource)
        ? resource.some((r) => matches(action, r))
        : matches(action, resource);
    },
    canSuper(): boolean {
      return false;
    },
  };
}
