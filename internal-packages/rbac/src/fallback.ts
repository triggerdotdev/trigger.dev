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

export class RoleBaseAccessFallback {
  constructor(private readonly prisma: PrismaClient) {}

  create(
    helpers: { getSessionUserId: (request: Request) => Promise<string | null> }
  ): RoleBaseAccessFallbackController {
    return new RoleBaseAccessFallbackController(this.prisma, helpers);
  }
}

class RoleBaseAccessFallbackController implements RoleBaseAccessController {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly helpers: { getSessionUserId: (request: Request) => Promise<string | null> }
  ) {}

  async authenticateBearer(
    request: Request,
    options?: { allowJWT?: boolean }
  ): Promise<BearerAuthResult> {
    const rawToken = request.headers.get("Authorization")?.replace(/^Bearer /, "").trim();
    if (!rawToken) return { ok: false, status: 401, error: "Invalid or Missing API key" };

    if (options?.allowJWT && isPublicJWT(rawToken)) {
      const envId = extractJWTSub(rawToken);
      if (!envId) return { ok: false, status: 401, error: "Invalid Public Access Token" };

      const env = await this.prisma.runtimeEnvironment.findFirst({
        where: { id: envId },
        include: {
          project: true,
          organization: true,
          parentEnvironment: { select: { apiKey: true } },
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
        environment: toRbacEnvironment(env),
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
    const include = {
      project: true,
      organization: true,
      orgMember: { select: { userId: true } },
      childEnvironments: branchName
        ? { where: { branchName, archivedAt: null } }
        : undefined,
    } as const;
    let env = await this.prisma.runtimeEnvironment.findFirst({
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
      const revoked = await this.prisma.revokedApiKey.findFirst({
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
      env = {
        ...child,
        apiKey: env.apiKey,
        orgMember: env.orgMember,
        organization: env.organization,
        project: env.project,
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
      environment: toRbacEnvironment(env),
      subject,
      ability: permissiveAbility,
    };
  }

  async authenticateSession(
    request: Request,
    context: { organizationId?: string; projectId?: string }
  ): Promise<SessionAuthResult> {
    const userId = await this.helpers.getSessionUserId(request);
    if (!userId) return { ok: false, reason: "unauthenticated" };

    const user = await this.prisma.user.findFirst({ where: { id: userId } });
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
    context: { organizationId?: string; projectId?: string },
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
    const pat = await this.prisma.personalAccessToken.findFirst({
      where: { hashedToken, revokedAt: null },
      select: { id: true, userId: true },
    });
    if (!pat) {
      return { ok: false, status: 401, error: "Invalid PAT" };
    }

    return {
      ok: true,
      tokenId: pat.id,
      userId: pat.userId,
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

function toRbacEnvironment(
  env: {
    id: string;
    slug: string;
    type: string;
    apiKey: string;
    pkApiKey: string;
    organizationId: string;
    projectId: string;
    organization: { id: string; slug: string; title: string };
    project: { id: string; slug: string; name: string; externalRef: string };
  }
): RbacEnvironment {
  return {
    id: env.id,
    slug: env.slug,
    type: env.type,
    apiKey: env.apiKey,
    pkApiKey: env.pkApiKey,
    organizationId: env.organizationId,
    projectId: env.projectId,
    organization: {
      id: env.organization.id,
      slug: env.organization.slug,
      title: env.organization.title,
    },
    project: {
      id: env.project.id,
      slug: env.project.slug,
      name: env.project.name,
      externalRef: env.project.externalRef,
    },
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
