/**
 * Plugin-owned metadata for a built-in system role. The plugin returns
 * these in canonical order (highest authority first) so the dashboard
 * can render columns / build a level ladder without knowing role names.
 *
 * Roles the plugin doesn't expose at all (e.g. seeded but with the
 * `is_hidden` flag set in the cloud plugin) are not returned by
 * `systemRoles()` — there's no "advertised but absent" state.
 *
 * `available` indicates whether the role is assignable on the *org's
 * plan*. v1: Free/Hobby plans get Owner+Admin available; Pro+ adds
 * Developer. Consumers may render unavailable rows with an upgrade
 * badge, hide them, or otherwise gate UI on the flag.
 */
export type SystemRole = {
  id: string;
  name: string;
  description: string;
  available: boolean;
};

export type Permission = {
  // `<action>:<subject>` — display name, derived from the ability rule.
  name: string;
  description: string;
  // Display bucket for the Roles page (e.g. "Runs", "Tasks"). The page
  // groups permissions by this string and lists groups in the order they
  // first appear in `allPermissions()`, so the plugin owns both the
  // bucket label and the section ordering. Omit for "no grouping".
  group?: string;
  // Inverted rules (CASL `cannot`) surface as ✗ in the Roles page.
  inverted?: boolean;
  // CASL conditions (e.g. `{ envType: "PRODUCTION" }`) — when present,
  // the Roles page renders a tier badge alongside the permission row.
  conditions?: Record<string, unknown>;
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
  // Extra fields a route may pass for condition-based ability checks —
  // e.g. `envType` for env-tier-scoped rules ("Member can read envvars
  // unless envType === 'PRODUCTION'"). The plugin's ability matcher
  // (CASL) reads these off the resource object; routes that don't use
  // conditional rules can keep passing `{ type, id? }`.
  [key: string]: unknown;
};

// The plugin contract carries the same env shape that host webapps' auth
// flows use. Defined in @trigger.dev/core so it's importable from any
// internal package without going through the plugin contract itself.
export type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import type { AuthenticatedEnvironment as RbacEnv } from "@trigger.dev/core/v3/auth/environment";

/** @deprecated Renamed to `AuthenticatedEnvironment`. Kept as alias for transitional code. */
export type RbacEnvironment = RbacEnv;

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
      environment: RbacEnv;
      subject: RbacSubject;
      ability: RbacAbility;
      jwt?: { realtime?: { skipColumns?: string[] }; oneTimeUse?: boolean };
    };

export type SessionAuthResult =
  | { ok: false; reason: "unauthenticated" | "unauthorized" }
  | { ok: true; user: RbacUser; subject: RbacSubject; ability: RbacAbility };

// PAT auth deliberately omits `environment` — PATs are user identity
// tokens, not environment tokens. The ability is resolved per-request
// from the user's role in the target org (passed via `context`),
// intersected with the PAT's optional max-role cap.
export type PatAuthResult =
  | { ok: false; status: 401 | 403; error: string }
  | {
      ok: true;
      tokenId: string;
      userId: string;
      // The token's stored `lastAccessedAt`, returned alongside the
      // identity so the host can throttle the per-request update in JS
      // (skip the DB roundtrip when the value is fresh). Plugins must
      // include this column in their auth lookup; the host owns the
      // throttle window + the UPDATE itself. Null on a never-accessed
      // token. The plugin contract requires this so the apiBuilder can
      // collapse PAT auth + lastAccessedAt update from 2 queries to 1
      // in the fresh-cache case — matching pre-RBAC main's query count.
      lastAccessedAt: Date | null;
      subject: RbacSubject;
      ability: RbacAbility;
    };

export interface RoleBaseAccessController {
  // True when a real RBAC plugin is loaded (i.e. cloud); false when the
  // OSS fallback is in use. Hosts gate behaviour that's only meaningful
  // when the plugin is present (e.g. skipping role-attachment writes,
  // hiding role-pickers in the UI, branching on whether ability checks
  // are authoritative or permissive).
  isUsingPlugin(): Promise<boolean>;

  // API routes (Bearer token): one DB query → identity + pre-built ability
  // options.allowJWT: when true, accepts PUBLIC_JWT tokens in addition to environment API keys
  authenticateBearer(request: Request, options?: { allowJWT?: boolean }): Promise<BearerAuthResult>;

  // Dashboard loaders/actions (session cookie): one DB query → user + pre-built ability.
  // The caller resolves `userId` from the session cookie and passes it in.
  // (`null` means "no authenticated user"; the plugin returns `{ ok: false,
  // reason: "unauthenticated" }`.) The plugin used to take a
  // `helpers.getSessionUserId(request)` callback at create-time; pulling the
  // userId resolution into the caller drops a static module-load coupling
  // from the plugin's host module to the host's session-cookie code.
  authenticateSession(
    request: Request,
    context: { userId: string | null; organizationId?: string; projectId?: string }
  ): Promise<SessionAuthResult>;

  // PAT-authenticated routes (Authorization: Bearer tr_pat_…). The token
  // identifies the user; the effective ability is `min(user's current
  // role in the target org, the PAT's optional max-role cap)`. The user's
  // actual org membership is the floor — if they've been demoted or
  // removed, the PAT auto-narrows. The cap is set at PAT creation and
  // ceilings the token even when the user is more privileged.
  //
  // No plugin installed → fallback returns a permissive ability so PAT
  // routes that don't yet declare an `authorization` block keep working
  // exactly as they did pre-RBAC.
  authenticatePat(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<PatAuthResult>;

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
    context: { userId: string | null; organizationId?: string; projectId?: string },
    check: { action: string; resource: RbacResource | RbacResource[] }
  ): Promise<SessionAuthResult>;

  // Plugin-owned catalogue of built-in system roles for the given org,
  // in canonical order (highest authority first). Returns null when no
  // plugin is installed — there are no seeded roles to refer to in that
  // case (the default fallback's `allRoles` returns []).
  //
  // Hidden roles (e.g. Member in v1) are filtered out entirely. Each
  // entry's `available` flag reflects whether the org's plan permits
  // assigning that role; consumers can render unavailable entries with
  // an upgrade badge or hide them.
  systemRoles(organizationId: string): Promise<SystemRole[] | null>;

  // Role introspection. The fallback returns []; a plugin may return
  // its own role catalogue.
  allPermissions(organizationId: string): Promise<Permission[]>;
  allRoles(organizationId: string): Promise<Role[]>;

  // Of the roles returned by `allRoles(organizationId)`, which IDs may
  // be assigned right now? Used by the Teams page UI to disable
  // role-dropdown options the org isn't allowed to assign. The default
  // fallback returns every role id (permissive — it doesn't apply any
  // gating). Server-side enforcement lives in setUserRole; this method
  // is purely a UI affordance.
  getAssignableRoleIds(organizationId: string): Promise<string[]>;

  // Role management. Mutation methods return a discriminated Result
  // rather than throwing — the dashboard surfaces `error` strings
  // directly to the user (system role edits, gating, validation
  // conflicts), so a thrown exception is only ever for unexpected
  // failures (DB outage, bug). The default fallback returns
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
  // methods above. The default fallback returns
  // `{ ok: false, error: "RBAC plugin not installed" }`.
  getUserRole(params: {
    userId: string;
    organizationId: string;
    projectId?: string;
  }): Promise<Role | null>;

  // Batch variant for callers that need per-user roles for many users
  // in one round-trip (e.g. the Team page rendering N members).
  // Org-scoped only — project-scoped reads still go through getUserRole.
  // Returns a Map keyed by userId; users with no resolvable role map to
  // null. The default fallback returns a Map of all userIds → null.
  getUserRoles(
    userIds: string[],
    organizationId: string
  ): Promise<Map<string, Role | null>>;

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
  create(): RoleBaseAccessController | Promise<RoleBaseAccessController>;
}
