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
  | { type: "personalAccessToken"; tokenId: string; organizationId: string; projectId?: string };

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
  can(action: string, resource: RbacResource): boolean;
  canSuper(): boolean;
}

export type BearerAuthResult =
  | { ok: false; status: 401 | 403; error: string }
  | { ok: true; environment: RbacEnvironment; subject: RbacSubject; ability: RbacAbility };

export type SessionAuthResult =
  | { ok: false; reason: "unauthenticated" | "unauthorized" }
  | { ok: true; user: RbacUser; subject: RbacSubject; ability: RbacAbility };

export interface RoleBaseAccessController {
  // API routes (Bearer token): one DB query → identity + pre-built ability
  authenticateBearer(request: Request): Promise<BearerAuthResult>;

  // Dashboard loaders/actions (session cookie): one DB query → user + pre-built ability
  authenticateSession(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<SessionAuthResult>;

  // Convenience: authenticate + ability.can() check in one call; returns ok:false if check fails
  authenticateAuthorizeBearer(
    request: Request,
    check: { action: string; resource: RbacResource }
  ): Promise<BearerAuthResult>;

  authenticateAuthorizeSession(
    request: Request,
    context: { organizationId?: string; projectId?: string },
    check: { action: string; resource: RbacResource }
  ): Promise<SessionAuthResult>;

  // Role introspection (enterprise: DB-backed; OSS: returns [])
  allPermissions(organizationId: string): Promise<Permission[]>;
  allRoles(organizationId: string): Promise<Role[]>;

  // Role management (throws in OSS fallback)
  createRole(params: {
    organizationId: string;
    name: string;
    description: string;
    permissions: string[];
  }): Promise<Role>;

  updateRole(params: {
    roleId: string;
    name?: string;
    description?: string;
    permissions?: string[];
  }): Promise<Role>;

  deleteRole(roleId: string): Promise<void>;

  // Role assignments (no-ops in OSS fallback)
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
  }): Promise<void>;

  removeUserRole(params: {
    userId: string;
    organizationId: string;
    projectId?: string;
  }): Promise<void>;

  getTokenRole(tokenId: string): Promise<Role | null>;
  setTokenRole(params: { tokenId: string; roleId: string }): Promise<void>;
  removeTokenRole(tokenId: string): Promise<void>;
}

export interface RoleBasedAccessControlPlugin {
  create(
    helpers: { getSessionUserId: (request: Request) => Promise<string | null> }
  ): RoleBaseAccessController | Promise<RoleBaseAccessController>;
}
