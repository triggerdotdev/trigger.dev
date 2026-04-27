export type Permission = {
  name: string;
  description: string;
};

export type Role = {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
};

export type RbacSubject =
  | { type: "user"; userId: string; organizationId: string; projectId?: string }
  | { type: "personalAccessToken"; tokenId: string; organizationId: string; projectId?: string }
  | { type: "publicJWT"; environmentId: string; organizationId: string; projectId?: string };

export type RbacResource = {
  type: string;
  id?: string;
};

export type RbacEnvironment = {
  id: string;
  slug: string;
  type: string;
  apiKey: string;
  pkApiKey: string;
  organizationId: string;
  projectId: string;
  organization: { id: string; slug: string; title: string };
  project: { id: string; slug: string; name: string; externalRef: string };
};

export type RbacUser = {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  admin: boolean;
  confirmedBasicDetails: boolean;
  isImpersonating: boolean;
};

/** Pre-built ability returned by authenticate* — all checks are sync, no DB call. */
export interface RbacAbility {
  // Array form means "grant access if any resource in the array passes" —
  // used by routes that touch multiple resources (e.g. a run also carries
  // a batch id, tags, a task identifier) so a JWT scoped to any of them
  // grants access.
  can(action: string, resource: RbacResource | RbacResource[]): boolean;
  canSuper(): boolean;
}

export type BearerAuthResult =
  | { ok: false; status: 401 | 403; error: string }
  | {
      ok: true;
      environment: RbacEnvironment;
      subject: RbacSubject;
      ability: RbacAbility;
      jwt?: { realtime?: { skipColumns?: string[] }; oneTimeUse?: boolean };
    };

export type SessionAuthResult =
  | { ok: false; reason: "unauthenticated" | "unauthorized" }
  | { ok: true; user: RbacUser; subject: RbacSubject; ability: RbacAbility };

export interface RoleBaseAccessController {
  // API routes (Bearer token): one DB query → identity + pre-built ability
  // options.allowJWT: when true, accepts PUBLIC_JWT tokens in addition to environment API keys
  authenticateBearer(request: Request, options?: { allowJWT?: boolean }): Promise<BearerAuthResult>;

  // Dashboard loaders/actions (session cookie): one DB query → user + pre-built ability
  authenticateSession(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<SessionAuthResult>;

  // Convenience: authenticate + ability.can() check in one call; returns ok:false if check fails.
  // resource accepts the same single-or-array shape as RbacAbility.can — array form means
  // "grant access if any element passes".
  authenticateAuthorizeBearer(
    request: Request,
    check: { action: string; resource: RbacResource | RbacResource[] },
    options?: { allowJWT?: boolean }
  ): Promise<BearerAuthResult>;

  authenticateAuthorizeSession(
    request: Request,
    context: { organizationId?: string; projectId?: string },
    check: { action: string; resource: RbacResource | RbacResource[] }
  ): Promise<SessionAuthResult>;

  // Role introspection (enterprise: DB-backed; OSS: returns [])
  allPermissions(organizationId: string): Promise<Permission[]>;
  allRoles(organizationId: string): Promise<Role[]>;

  // Of the roles returned by `allRoles(organizationId)`, which IDs may
  // be assigned right now? Used by the Teams page UI to disable
  // role-dropdown options outside the org's plan tier (system roles
  // gated by the subscription plan, custom roles only on Enterprise).
  // OSS fallback returns every role id (permissive — the OSS path
  // doesn't enforce plan gating). The actual server-side enforcement
  // lives in setUserRole; this method is purely for UI affordance.
  getAssignableRoleIds(organizationId: string): Promise<string[]>;

  // Role management. Mutation methods return a discriminated Result
  // rather than throwing — the cloud webapp surfaces `error` strings
  // directly to the user (system role edits, plan-gating, validation
  // conflicts), so a thrown exception is only ever for unexpected
  // failures (DB outage, bug). The OSS fallback returns
  // `{ ok: false, error: "RBAC plugin not installed" }` for these.
  createRole(params: {
    organizationId: string;
    name: string;
    description: string;
    permissions: string[];
  }): Promise<RoleMutationResult>;

  updateRole(params: {
    roleId: string;
    name?: string;
    description?: string;
    permissions?: string[];
  }): Promise<RoleMutationResult>;

  deleteRole(roleId: string): Promise<RoleAssignmentResult>;

  // Role assignments. Same Result discipline as the role-management
  // methods above. The OSS fallback returns
  // `{ ok: false, error: "RBAC plugin not installed" }`.
  getUserRole(params: {
    userId: string;
    organizationId: string;
    projectId?: string;
  }): Promise<Role | null>;

  setUserRole(params: {
    userId: string;
    organizationId: string;
    roleId: string;
    projectId?: string;
  }): Promise<RoleAssignmentResult>;

  removeUserRole(params: {
    userId: string;
    organizationId: string;
    projectId?: string;
  }): Promise<RoleAssignmentResult>;

  getTokenRole(tokenId: string): Promise<Role | null>;
  setTokenRole(params: { tokenId: string; roleId: string }): Promise<RoleAssignmentResult>;
  removeTokenRole(tokenId: string): Promise<RoleAssignmentResult>;
}

// Mutation result for role create/update — success carries the new
// `role`, failure carries a user-facing `error` string.
export type RoleMutationResult =
  | { ok: true; role: Role }
  | { ok: false; error: string };

// Result for assignment / deletion mutations that don't return a value.
export type RoleAssignmentResult = { ok: true } | { ok: false; error: string };

export interface RoleBasedAccessControlPlugin {
  create(
    helpers: { getSessionUserId: (request: Request) => Promise<string | null> }
  ): RoleBaseAccessController | Promise<RoleBaseAccessController>;
}
