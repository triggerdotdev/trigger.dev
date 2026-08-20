import type {
  Permission,
  Role,
  RbacUser,
  RbacSubject,
  RbacResource,
  BearerAuthOptions,
  BearerAuthResult,
  PatAuthResult,
  SessionAuthResult,
  RoleAssignmentResult,
  RoleBaseAccessController,
  RoleMutationResult,
  UserActorAuthResult,
} from "@trigger.dev/plugins";
import {
  FULL_ACCESS_PRESET_ID,
  isUserActorToken,
  verifyUserActorToken,
} from "@trigger.dev/plugins";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@trigger.dev/database";
import { buildFallbackAbility, buildJwtAbility, permissiveAbility } from "./ability.js";
import { BearerCredentialResolver } from "./bearerCredentials.js";

// Reads only: a capless token still has to reach its own JWT exchange (gated on `read:apiKeys`).
export const CAPLESS_USER_ACTOR_SCOPES = ["read:all"];

export type FallbackPrismaClients = {
  // Used for writes (setUserRole, mutateRole, etc.) and any reads that
  // can't tolerate replica lag (currently none on this controller, but
  // kept for symmetry with the rest of the webapp).
  primary: PrismaClient;
  // Used for read-only auth-path queries: bearer-token env lookup,
  // PAT lookup, session user lookup. Spreads the high-frequency auth
  // load away from the primary, matching what `findEnvironmentByApiKey`
  // / `findEnvironmentById` did before this PR.
  replica: PrismaClient;
};

// Backwards-compat: a single PrismaClient is treated as both primary
// and replica. Callers that care about replica isolation pass the
// explicit FallbackPrismaClients shape.
type PrismaInput = PrismaClient | FallbackPrismaClients;

function resolvePrismaClients(input: PrismaInput): FallbackPrismaClients {
  return "primary" in input ? input : { primary: input, replica: input };
}

export type FallbackOptions = {
  // Platform secret for verifying delegated user-actor tokens (tr_uat_).
  userActorSecret?: string;
  additionalApiKeyLookupEnabled?: () => boolean;
};

export class RoleBaseAccessFallback {
  private readonly clients: FallbackPrismaClients;
  private readonly options: FallbackOptions;

  constructor(prisma: PrismaInput, options?: FallbackOptions) {
    this.clients = resolvePrismaClients(prisma);
    this.options = options ?? {};
  }

  create(): RoleBaseAccessFallbackController {
    return new RoleBaseAccessFallbackController(this.clients, this.options);
  }
}

class RoleBaseAccessFallbackController implements RoleBaseAccessController {
  private readonly prisma: PrismaClient; // alias for primary — used by writes
  private readonly replica: PrismaClient;
  private readonly userActorSecret?: string;
  // Bearer-token resolution (JWTs, root keys, additional API keys) is always-on
  // host logic, not an RBAC default — see bearerCredentials.ts.
  private readonly bearer: BearerCredentialResolver;

  constructor(clients: FallbackPrismaClients, options?: FallbackOptions) {
    this.prisma = clients.primary;
    this.replica = clients.replica;
    this.userActorSecret = options?.userActorSecret;
    this.bearer = new BearerCredentialResolver(clients, options?.additionalApiKeyLookupEnabled);
  }

  async isUsingPlugin(): Promise<boolean> {
    return false;
  }

  async authenticateBearer(
    request: Request,
    options?: BearerAuthOptions
  ): Promise<BearerAuthResult> {
    return this.bearer.authenticate(request, options);
  }

  async authenticateSession(
    _request: Request,
    context: { userId: string | null; organizationId?: string; projectId?: string }
  ): Promise<SessionAuthResult> {
    if (!context.userId) return { ok: false, reason: "unauthenticated" };

    const user = await this.replica.user.findFirst({ where: { id: context.userId } });
    if (!user) return { ok: false, reason: "unauthenticated" };

    // A non-member in a scoped context is denied, not handed a permissive
    // ability. buildFallbackAbility is permissive for a non-admin
    // (can: () => true), so ability.can is not a tenant floor; returning it here
    // let a non-member act on any org whose slug they knew. An unscoped context
    // stays permissive (identity-only checks predate any scope), and a platform
    // admin keeps their ability.
    if (!user.admin) {
      const denied = await this.deniedByMembership(
        context.organizationId,
        context.projectId,
        user.id
      );
      if (denied) return { ok: false, reason: "unauthorized" };
    }

    const subject: RbacSubject = {
      type: "user",
      userId: user.id,
      organizationId: context.organizationId ?? "",
      projectId: context.projectId,
    };

    return {
      ok: true,
      user: toRbacUser(user),
      subject,
      ability: buildFallbackAbility(user.admin),
    };
  }

  /**
   * Whether a non-admin user is outside the tenant a scoped context names. A project-only scope
   * resolves through the project's organization, so the floor holds whichever scope a route
   * resolves; an unscoped context is not a tenant claim and is never denied here.
   *
   * Both lookups read the replica first and fall back to the primary before denying: org creation,
   * invite acceptance and SSO provisioning all write to the primary, so a member who just joined
   * must not be bounced while the row replicates.
   */
  private async deniedByMembership(
    organizationId: string | undefined,
    projectId: string | undefined,
    userId: string
  ): Promise<boolean> {
    let orgId = organizationId;

    if (!orgId && projectId) {
      const project =
        (await this.replica.project.findFirst({
          where: { id: projectId },
          select: { organizationId: true },
        })) ??
        (await this.prisma.project.findFirst({
          where: { id: projectId },
          select: { organizationId: true },
        }));
      // An unresolvable project names no tenant, so there is nothing to deny against.
      if (!project) return false;
      orgId = project.organizationId;
    }

    if (!orgId) return false;

    const where = { organizationId: orgId, userId };
    const member =
      (await this.replica.orgMember.findFirst({ where, select: { id: true } })) ??
      (await this.prisma.orgMember.findFirst({ where, select: { id: true } }));
    return !member;
  }

  async authenticateAuthorizeBearer(
    request: Request,
    check: { action: string; resource: RbacResource | RbacResource[] },
    options?: BearerAuthOptions
  ): Promise<BearerAuthResult> {
    const auth = await this.authenticateBearer(request, options);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false, status: 403, error: "Unauthorized" };
    }
    return auth;
  }

  async authenticateAuthorizeSession(
    request: Request,
    context: { userId: string | null; organizationId?: string; projectId?: string },
    check: { action: string; resource: RbacResource | RbacResource[] }
  ): Promise<SessionAuthResult> {
    const auth = await this.authenticateSession(request, context);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false, reason: "unauthorized" };
    }
    return auth;
  }

  async authenticatePat(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<PatAuthResult> {
    const rawToken = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    if (!rawToken || !rawToken.startsWith("tr_pat_")) {
      return { ok: false, status: 401, error: "Invalid or Missing PAT" };
    }

    const hashedToken = createHash("sha256").update(rawToken).digest("hex");
    const pat = await this.replica.personalAccessToken.findFirst({
      where: { hashedToken, revokedAt: null },
      // Include `lastAccessedAt` so the host can throttle its own write
      // (see `PatAuthResult.lastAccessedAt` jsdoc). Without this the host
      // would need a second findFirst just to decide whether to fire the
      // updateMany, turning 1 DB roundtrip into 2.
      select: { id: true, userId: true, lastAccessedAt: true },
    });
    if (!pat) {
      return { ok: false, status: 401, error: "Invalid PAT" };
    }

    return {
      ok: true,
      tokenId: pat.id,
      userId: pat.userId,
      lastAccessedAt: pat.lastAccessedAt,
      subject: {
        type: "personalAccessToken",
        tokenId: pat.id,
        organizationId: context.organizationId ?? "",
        projectId: context.projectId,
      },
      // No plugin → no role lookup. PATs in the OSS world are pure
      // user-identity tokens; the route's own authorization block (or
      // the absence of one) decides what they can do, same as it did
      // before this method existed.
      ability: permissiveAbility,
    };
  }

  async authenticateUserActor(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<UserActorAuthResult> {
    const rawToken = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    if (!rawToken || !isUserActorToken(rawToken)) {
      return { ok: false, status: 401, error: "Invalid or Missing user-actor token" };
    }
    if (!this.userActorSecret) {
      return { ok: false, status: 401, error: "User-actor tokens are not configured" };
    }
    const claims = await verifyUserActorToken(this.userActorSecret, rawToken);
    if (!claims) {
      return { ok: false, status: 401, error: "Invalid user-actor token" };
    }

    // Same tenant floor as authenticateSession: in a scoped context a non-member's
    // delegated token is denied here, not handed a usable ability (even for reads).
    // Admins are exempt. An unscoped context is not a tenant claim — skip the lookup
    // entirely and keep the prior behavior (no user query, no denial).
    if (context.organizationId || context.projectId) {
      const where = { id: claims.userId };
      const user =
        (await this.replica.user.findFirst({ where, select: { id: true, admin: true } })) ??
        (await this.prisma.user.findFirst({ where, select: { id: true, admin: true } }));
      if (!user) {
        return { ok: false, status: 401, error: "Invalid user-actor token" };
      }
      if (!user.admin) {
        const denied = await this.deniedByMembership(
          context.organizationId,
          context.projectId,
          user.id
        );
        if (denied) return { ok: false, status: 403, error: "Unauthorized" };
      }
    }

    return {
      ok: true,
      userId: claims.userId,
      claims,
      subject: {
        type: "userActor",
        userId: claims.userId,
        client: claims.client,
        environmentId: claims.environmentId,
        organizationId: context.organizationId ?? "",
        projectId: context.projectId,
      },
      // A delegated token is a downgrade of the user: never the blanket ability a PAT gets here.
      ability: buildJwtAbility(claims.cap ?? CAPLESS_USER_ACTOR_SCOPES),
    };
  }

  async systemRoles(_organizationId: string) {
    // No plugin installed → no seeded roles. Callers handle null by
    // hiding role-picker UI / skipping role assignment writes.
    return null;
  }

  async apiKeyPresets(_organizationId: string) {
    return null;
  }

  async prepareApiKeyPolicy(params: {
    organizationId: string;
    presetId: string;
    taskIdentifiers?: string[];
  }) {
    // Without a plugin there is no preset catalogue, so full access is the only
    // policy on offer — but the caller still has to ask for it by name. Any
    // other preset, or any task selection, is a restricted key and unavailable.
    if (params.presetId !== FULL_ACCESS_PRESET_ID || (params.taskIdentifiers?.length ?? 0) > 0) {
      return { ok: false as const, error: "API key access presets are not available" };
    }

    // `presetId: null` because this install has no catalogue to reference — the
    // key is full-access, not an instance of a named preset.
    return {
      ok: true as const,
      policy: { presetId: null, scopes: ["admin"] },
    };
  }

  async describeApiKeyPolicy() {
    return {};
  }

  async allPermissions(): Promise<Permission[]> {
    return [];
  }

  async allRoles(): Promise<Role[]> {
    return [];
  }

  // Permissive — the default fallback applies no gating. The Teams
  // page UI uses this to decide which role options to render as
  // disabled; with no plugin installed allRoles() returns [] anyway,
  // so the practical effect is "no roles to gate".
  async getAssignableRoleIds(): Promise<string[]> {
    return [];
  }

  async createRole(): Promise<RoleMutationResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }

  async updateRole(): Promise<RoleMutationResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }

  async deleteRole(): Promise<RoleAssignmentResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }

  async getUserRole(): Promise<Role | null> {
    return null;
  }

  async getUserRoles(userIds: string[]): Promise<Map<string, Role | null>> {
    return new Map(userIds.map((id) => [id, null]));
  }

  async setUserRole(): Promise<RoleAssignmentResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }

  async removeUserRole(): Promise<RoleAssignmentResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }

  async getTokenRole(): Promise<Role | null> {
    return null;
  }

  async setTokenRole(): Promise<RoleAssignmentResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }

  async removeTokenRole(): Promise<RoleAssignmentResult> {
    return { ok: false, error: "RBAC plugin not installed" };
  }
}

function toRbacUser(user: {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  admin: boolean;
  confirmedBasicDetails: boolean;
}): RbacUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    admin: user.admin,
    confirmedBasicDetails: user.confirmedBasicDetails,
    isImpersonating: false,
  };
}
