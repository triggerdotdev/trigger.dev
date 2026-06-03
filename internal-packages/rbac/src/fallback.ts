import type {
  Permission,
  Role,
  RbacEnvironment,
  RbacUser,
  RbacSubject,
  RbacResource,
  BearerAuthResult,
  PatAuthResult,
  SessionAuthResult,
  RoleAssignmentResult,
  RoleBaseAccessController,
  RoleMutationResult,
} from "@trigger.dev/plugins";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@trigger.dev/database";
import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { buildFallbackAbility, buildJwtAbility, permissiveAbility } from "./ability.js";

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

export class RoleBaseAccessFallback {
  private readonly clients: FallbackPrismaClients;

  constructor(prisma: PrismaInput) {
    this.clients = resolvePrismaClients(prisma);
  }

  create(): RoleBaseAccessFallbackController {
    return new RoleBaseAccessFallbackController(this.clients);
  }
}

class RoleBaseAccessFallbackController implements RoleBaseAccessController {
  private readonly prisma: PrismaClient; // alias for primary — used by writes
  private readonly replica: PrismaClient;

  constructor(clients: FallbackPrismaClients) {
    this.prisma = clients.primary;
    this.replica = clients.replica;
  }

  async isUsingPlugin(): Promise<boolean> {
    return false;
  }

  async authenticateBearer(
    request: Request,
    options?: { allowJWT?: boolean }
  ): Promise<BearerAuthResult> {
    // Deprecated public API keys (`pk_*` minted long before public JWTs
    // landed) are intentionally NOT handled here. The legacy
    // `findEnvironmentByPublicApiKey` path looked them up via the
    // `pkApiKey` column, but that token format hasn't been issued for
    // years and no live client should be sending one. Any `pk_*` bearer
    // on a route that goes through the apiBuilder now returns 401 —
    // public access goes through the JWT path (`isPublicJWT(rawToken)`
    // below) instead. The deprecated lookup is still exported from
    // `apps/webapp/app/models/runtimeEnvironment.server.ts` for the
    // pre-RBAC routes that haven't been migrated, but it's a dead
    // code path for any route that uses `createLoaderApiRoute` /
    // `createActionApiRoute`.
    const rawToken = request.headers.get("Authorization")?.replace(/^Bearer /, "").trim();
    if (!rawToken) return { ok: false, status: 401, error: "Invalid or Missing API key" };

    if (options?.allowJWT && isPublicJWT(rawToken)) {
      const envId = extractJWTSub(rawToken);
      if (!envId) return { ok: false, status: 401, error: "Invalid Public Access Token" };

      // Match the include shape of the slim AuthenticatedEnvironment so
      // the bridge can use the returned env without a follow-up fetch.
      const env = await this.replica.runtimeEnvironment.findFirst({
        where: { id: envId },
        include: {
          project: true,
          organization: true,
          orgMember: {
            select: {
              userId: true,
              user: { select: { id: true, displayName: true, name: true } },
            },
          },
          parentEnvironment: { select: { id: true, apiKey: true } },
        },
      });
      if (!env || env.project.deletedAt !== null) {
        return { ok: false, status: 401, error: "Invalid Public Access Token" };
      }

      const signingKey = env.parentEnvironment?.apiKey ?? env.apiKey;
      const result = await validateJWT(rawToken, signingKey);
      if (!result.ok) return { ok: false, status: 401, error: "Public Access Token is invalid" };

      const scopes = Array.isArray(result.payload.scopes)
        ? (result.payload.scopes as string[])
        : [];
      const realtime = result.payload.realtime as { skipColumns?: string[] } | undefined;
      const oneTimeUse = result.payload.otu === true;

      return {
        ok: true,
        environment: toAuthenticatedEnvironment(env),
        subject: {
          type: "publicJWT",
          environmentId: env.id,
          organizationId: env.organizationId,
          projectId: env.projectId,
        },
        ability: buildJwtAbility(scopes),
        jwt: { realtime, oneTimeUse },
      };
    }

    // PREVIEW envs are parents — operating "on a branch" means routing
    // to a child env keyed by branchName. The customer authenticates
    // with the parent's apiKey + an `x-trigger-branch` header. Mirror
    // findEnvironmentByApiKey: include the matching child env so the
    // pivot below can adopt its identity.
    const branchName = sanitizeBranchName(request.headers.get("x-trigger-branch"));
    // Match the include shape of the slim AuthenticatedEnvironment so
    // the apiBuilder bridge can use the returned env directly without a
    // follow-up findEnvironmentById call.
    const include = {
      project: true,
      organization: true,
      orgMember: {
        select: {
          userId: true,
          user: { select: { id: true, displayName: true, name: true } },
        },
      },
      parentEnvironment: { select: { id: true, apiKey: true } },
      childEnvironments: branchName
        ? { where: { branchName, archivedAt: null } }
        : undefined,
    } as const;
    let env = await this.replica.runtimeEnvironment.findFirst({
      where: { apiKey: rawToken },
      include,
    });

    // Revoked API key grace window — mirrors `findEnvironmentByApiKey`
    // in apps/webapp/app/models/runtimeEnvironment.server.ts. Recently
    // rotated keys keep working until their `expiresAt`; without this
    // branch a customer who rotates an env API key gets immediate 401s
    // on the new auth path. The PR's e2e suite covers this in
    // auth-cross-cutting.e2e.full.test.ts ("revoked key within grace").
    if (!env) {
      const revoked = await this.replica.revokedApiKey.findFirst({
        where: { apiKey: rawToken, expiresAt: { gt: new Date() } },
        include: { runtimeEnvironment: { include } },
      });
      env = revoked?.runtimeEnvironment ?? null;
    }

    if (!env || env.project.deletedAt !== null) {
      return { ok: false, status: 401, error: "Invalid API key" };
    }

    // PREVIEW env requires a branch header; pivot to the child env so
    // downstream code operates on the branch (its own id, but the
    // parent's apiKey/orgMember/organization/project — exactly what
    // findEnvironmentByApiKey does for the legacy auth path).
    if (env.type === "PREVIEW") {
      if (!branchName) {
        return {
          ok: false,
          status: 401,
          error: "x-trigger-branch header required for preview env",
        };
      }
      const child = env.childEnvironments?.[0];
      if (!child) {
        return { ok: false, status: 401, error: "No matching branch env" };
      }
      // Pivot to the child env: child's id/type/branchName, parent's
      // apiKey/orgMember/organization/project. parentEnvironment is set
      // explicitly here so the slim shape stays internally consistent.
      env = {
        ...child,
        apiKey: env.apiKey,
        orgMember: env.orgMember,
        organization: env.organization,
        project: env.project,
        parentEnvironment: { id: env.id, apiKey: env.apiKey },
        childEnvironments: [],
      };
    }

    const subject: RbacSubject = {
      type: "user",
      userId: env.orgMember?.userId ?? "",
      organizationId: env.organizationId,
      projectId: env.projectId,
    };

    return {
      ok: true,
      environment: toAuthenticatedEnvironment(env),
      subject,
      ability: permissiveAbility,
    };
  }

  async authenticateSession(
    _request: Request,
    context: { userId: string | null; organizationId?: string; projectId?: string }
  ): Promise<SessionAuthResult> {
    if (!context.userId) return { ok: false, reason: "unauthenticated" };

    const user = await this.replica.user.findFirst({ where: { id: context.userId } });
    if (!user) return { ok: false, reason: "unauthenticated" };

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

  async authenticateAuthorizeBearer(
    request: Request,
    check: { action: string; resource: RbacResource | RbacResource[] },
    options?: { allowJWT?: boolean }
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

  async systemRoles(_organizationId: string) {
    // No plugin installed → no seeded roles. Callers handle null by
    // hiding role-picker UI / skipping role assignment writes.
    return null;
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

function isPublicJWT(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload !== null && typeof payload === "object" && payload.pub === true;
  } catch {
    return false;
  }
}

function extractJWTSub(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload !== null && typeof payload === "object" && typeof payload.sub === "string"
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
}

// Coerce a Prisma RuntimeEnvironment payload (with project/organization/
// orgMember/parentEnvironment includes) into the slim AuthenticatedEnvironment
// the auth contract carries. The slim type accepts both `number` and
// Decimal-like for `concurrencyLimitBurstFactor`, but explicit coercion
// here keeps the value a plain number across the auth boundary so
// downstream consumers don't have to narrow before doing arithmetic.
function toAuthenticatedEnvironment(env: RbacEnvironment): RbacEnvironment {
  const burst = env.concurrencyLimitBurstFactor;
  return {
    ...env,
    concurrencyLimitBurstFactor: typeof burst === "number" ? burst : burst.toNumber(),
  };
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
