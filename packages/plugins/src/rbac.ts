/**
 * Plugin-owned metadata for a built-in system role. The plugin returns
 * these in canonical order (highest authority first) so the dashboard
 * can render columns / build a level ladder without knowing role names.
 *
 * Roles the plugin chooses not to expose at all (e.g. seeded but hidden)
 * are not returned by `systemRoles()` — there's no "advertised but
 * absent" state.
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
  // Inverted (deny) rules surface as ✗ in the Roles page.
  inverted?: boolean;
  // Rule conditions (e.g. `{ envType: "PRODUCTION" }`) — when present,
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
  | { type: "publicJWT"; environmentId: string; organizationId: string; projectId?: string }
  // Delegated user-actor token (`tr_uat_…`): a short-lived, stateless
  // credential that authenticates as `userId`. `client` records what minted
  // it (e.g. a dashboard agent) for attribution.
  | {
      type: "userActor";
      userId: string;
      client?: string;
      organizationId: string;
      projectId?: string;
    };

export type RbacResource = {
  type: string;
  id?: string;
  // Extra fields a route may pass for condition-based ability checks —
  // e.g. `envType` for env-tier-scoped rules ("Member can read envvars
  // unless envType === 'PRODUCTION'"). The plugin's ability matcher
  // reads these off the resource object; routes that don't use
  // conditional rules can keep passing `{ type, id? }`.
  [key: string]: unknown;
};

// The plugin contract carries the same env shape that host webapps' auth
// flows use. Defined in @trigger.dev/core so it's importable from any
// internal package without going through the plugin contract itself.
export type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import type { AuthenticatedEnvironment as RbacEnv } from "@trigger.dev/core/v3/auth/environment";
import { generateJWT, validateJWT } from "@trigger.dev/core/v3/jwt";

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

/**
 * Builds an ability from JWT scope strings like "read:runs",
 * "read:runs:run_abc", "read:all", "admin".
 *
 * This is the single source of truth for interpreting public-token scope
 * strings. Both the host's built-in fallback and any auth plugin import it
 * from here so a token minted by the host is decoded identically no matter
 * which auth path serves the request — two copies of this grammar would
 * drift, and the difference would silently change what a token grants.
 */
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
      // resources of that type. Treating `admin:<anything>` as universal
      // would silently broaden any such tokens beyond the narrow,
      // route-listed grant they had before scope-based abilities.
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
      // legacy multi-key authorization semantic.
      return Array.isArray(resource)
        ? resource.some((r) => matches(action, r))
        : matches(action, resource);
    },
    canSuper(): boolean {
      return false;
    },
  };
}

// ── Delegated user-actor token grammar ───────────────────────────────────
//
// A `tr_uat_…` token is the JWT body (signed HS256 with the platform secret)
// behind a routing prefix. Single source of truth for minting/verifying so
// the host, its fallback, and any auth plugin agree on the wire format — same
// reasoning as `buildJwtAbility`. Built on core's `generateJWT`/`validateJWT`
// so it shares the issuer/audience/alg the rest of the platform's JWTs use.

export const USER_ACTOR_TOKEN_PREFIX = "tr_uat_";
// Distinguishes a UAT from other platform-secret-signed JWTs.
const USER_ACTOR_KIND = "user_actor";

export type UserActorClaims = {
  userId: string;
  client?: string;
  sessionId?: string;
  // Optional scope cap (e.g. `["read:runs"]`) — ceilings the token below the
  // user's role. Absent today; the auth path is already cap-ready.
  cap?: string[];
};

export function isUserActorToken(token: string): boolean {
  return token.startsWith(USER_ACTOR_TOKEN_PREFIX);
}

export async function signUserActorToken(
  secret: string,
  opts: {
    userId: string;
    client: string;
    sessionId?: string;
    cap?: string[];
    expirationTime?: string | number | Date;
  }
): Promise<string> {
  const jwt = await generateJWT({
    secretKey: secret,
    payload: {
      kind: USER_ACTOR_KIND,
      sub: opts.userId,
      act: { client: opts.client, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) },
      ...(opts.cap ? { cap: opts.cap } : {}),
    },
    expirationTime: opts.expirationTime ?? "1h",
  });
  return `${USER_ACTOR_TOKEN_PREFIX}${jwt}`;
}

// undefined for anything that isn't a valid, unexpired, correctly-signed UAT.
export async function verifyUserActorToken(
  secret: string,
  token: string
): Promise<UserActorClaims | undefined> {
  if (!isUserActorToken(token)) return;

  const result = await validateJWT(token.slice(USER_ACTOR_TOKEN_PREFIX.length), secret);
  if (!result.ok) return;

  const payload = result.payload;
  if (payload.kind !== USER_ACTOR_KIND || typeof payload.sub !== "string") return;

  const act = payload.act as { client?: string; sessionId?: string } | undefined;
  return {
    userId: payload.sub,
    client: act?.client,
    sessionId: act?.sessionId,
    cap: Array.isArray(payload.cap) ? (payload.cap as string[]) : undefined,
  };
}

export type BearerAuthResult =
  | { ok: false; status: 401 | 403; error: string }
  | {
      ok: true;
      environment: RbacEnv;
      subject: RbacSubject;
      ability: RbacAbility;
      // `act` carries the acting user (`act.sub`) when the public JWT was
      // minted from a PAT/UAT exchange that stamped a delegation claim. Hosts
      // surface it for attribution (e.g. who resolved an error).
      jwt?: { realtime?: { skipColumns?: string[] }; oneTimeUse?: boolean; act?: { sub: string } };
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

// Like PatAuthResult but stateless — a UAT has no stored row, so there's no
// `tokenId`/`lastAccessedAt`. The ability is `min(user's role in the target
// org, the token's optional scope cap)`, same cap-and-floor model as PATs.
export type UserActorAuthResult =
  | { ok: false; status: 401 | 403; error: string }
  | {
      ok: true;
      userId: string;
      subject: RbacSubject;
      ability: RbacAbility;
    };

export interface RoleBaseAccessController {
  // True when a real RBAC plugin is loaded; false when the built-in
  // fallback is in use. Hosts gate behaviour that's only meaningful
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

  // Delegated user-actor token routes (Authorization: Bearer tr_uat_…). The
  // plugin verifies the token itself (stateless — no DB lookup of the token)
  // and resolves the same cap-and-floor ability a PAT would for the same
  // user: floor = the user's role in the target org (rejects non-members,
  // like authenticatePat), cap = the token's optional scope cap.
  //
  // No plugin installed → fallback verifies the token and returns a
  // permissive ability, mirroring the fallback's PAT behaviour.
  authenticateUserActor(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<UserActorAuthResult>;

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
  getUserRoles(userIds: string[], organizationId: string): Promise<Map<string, Role | null>>;

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
export type RoleMutationResult = { ok: true; role: Role } | { ok: false; error: string };

// Result for assignment / deletion mutations that don't return a value.
export type RoleAssignmentResult = { ok: true } | { ok: false; error: string };

// Host-injected configuration the plugin can't read from the environment
// itself (the plugin runs in the host's process but owns no env contract).
export type RbacPluginConfig = {
  // Platform secret the host signs user-actor tokens with; the plugin uses
  // it to verify them in `authenticateUserActor`. Omitted → UAT auth 401s.
  userActorSecret?: string;
};

export interface RoleBasedAccessControlPlugin {
  create(config?: RbacPluginConfig): RoleBaseAccessController | Promise<RoleBaseAccessController>;
}
