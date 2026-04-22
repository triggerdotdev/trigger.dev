import type {
  Permission,
  Role,
  RbacEnvironment,
  RbacUser,
  RbacSubject,
  RbacResource,
  BearerAuthResult,
  SessionAuthResult,
  RoleBaseAccessController,
} from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { buildFallbackAbility, permissiveAbility } from "./ability.js";

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

  async authenticateBearer(request: Request): Promise<BearerAuthResult> {
    const apiKey = request.headers.get("Authorization")?.replace(/^Bearer /, "").trim();
    if (!apiKey) return { ok: false, status: 401, error: "Invalid or Missing API key" };

    const env = await this.prisma.runtimeEnvironment.findFirst({
      where: { apiKey },
      include: {
        project: true,
        organization: true,
        orgMember: { select: { userId: true } },
      },
    });

    if (!env || env.project.deletedAt !== null) {
      return { ok: false, status: 401, error: "Invalid API key" };
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
    check: { action: string; resource: RbacResource }
  ): Promise<BearerAuthResult> {
    const auth = await this.authenticateBearer(request);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false, status: 403, error: "Unauthorized" };
    }
    return auth;
  }

  async authenticateAuthorizeSession(
    request: Request,
    context: { organizationId?: string; projectId?: string },
    check: { action: string; resource: RbacResource }
  ): Promise<SessionAuthResult> {
    const auth = await this.authenticateSession(request, context);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false, reason: "unauthorized" };
    }
    return auth;
  }

  async allPermissions(): Promise<Permission[]> {
    return [];
  }

  async allRoles(): Promise<Role[]> {
    return [];
  }

  async createRole(): Promise<Role> {
    throw new Error("RBAC plugin not installed");
  }

  async updateRole(): Promise<Role> {
    throw new Error("RBAC plugin not installed");
  }

  async deleteRole(): Promise<void> {}

  async getUserRole(): Promise<Role | null> {
    return null;
  }

  async setUserRole(): Promise<void> {}
  async removeUserRole(): Promise<void> {}

  async getTokenRole(): Promise<Role | null> {
    return null;
  }

  async setTokenRole(): Promise<void> {}
  async removeTokenRole(): Promise<void> {}
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
