import type { RbacAbility } from "@trigger.dev/plugins";

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
  return {
    can(action: string, resource: { type: string; id?: string }): boolean {
      return scopes.some((scope) => {
        const [scopeAction, scopeType, scopeId] = scope.split(":");
        if (scopeAction === "admin") return true;
        if (scopeAction !== action && scopeAction !== "*") return false;
        if (scopeType === "all") return true;
        if (scopeType !== resource.type) return false;
        if (!scopeId) return true;
        return scopeId === resource.id;
      });
    },
    canSuper(): boolean {
      return false;
    },
  };
}
