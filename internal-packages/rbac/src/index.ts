import type {
  Permission,
  RbacAbility,
  Role,
  RbacResource,
  RoleAssignmentResult,
  RoleBaseAccessController,
  RoleBasedAccessControlPlugin,
  RoleMutationResult,
} from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { RoleBaseAccessFallback } from "./fallback.js";
export type { RoleBaseAccessController, RbacAbility, RbacResource } from "@trigger.dev/plugins";

type RbacHelpers = { getSessionUserId: (request: Request) => Promise<string | null> };

export type RbacCreateOptions = {
  // When true, skip loading the enterprise plugin and use the OSS fallback directly.
  // Useful for tests that need deterministic auth behavior without the enterprise plugin.
  forceFallback?: boolean;
};

// Route actions that historically authorised via the legacy checkAuthorization's
// superScopes escape hatch — e.g. a JWT with scope "write:tasks" was accepted by
// a route with action: "trigger" because "write:tasks" was listed in the route's
// superScopes array. The new ability model matches scope-action strictly, so we
// restore the prior semantic here: when the underlying ability denies for action
// X, retry with each aliased action. The retry covers both OSS fallback
// (scope-based buildJwtAbility) and enterprise (DB/CASL-based) paths
// transparently — neither implementation needs to know about aliases.
const ACTION_ALIASES: Record<string, readonly string[]> = {
  trigger: ["write"],
  batchTrigger: ["write"],
  update: ["write"],
};

export function withActionAliases(underlying: RbacAbility): RbacAbility {
  return {
    can(action: string, resource: RbacResource | RbacResource[]): boolean {
      if (underlying.can(action, resource)) return true;
      const aliases = ACTION_ALIASES[action] ?? [];
      return aliases.some((a) => underlying.can(a, resource));
    },
    canSuper: () => underlying.canSuper(),
  };
}

// Loads the enterprise plugin lazily; falls back to the OSS implementation if not installed.
// Synchronous create() avoids top-level await (not supported in the webapp's CJS build).
class LazyController implements RoleBaseAccessController {
  private readonly _init: Promise<RoleBaseAccessController>;

  constructor(prisma: PrismaClient, helpers: RbacHelpers, options?: RbacCreateOptions) {
    this._init = this.load(prisma, helpers, options);
  }

  private async load(
    prisma: PrismaClient,
    helpers: RbacHelpers,
    options?: RbacCreateOptions
  ): Promise<RoleBaseAccessController> {
    if (options?.forceFallback) {
      return new RoleBaseAccessFallback(prisma).create(helpers);
    }
    try {
      const moduleName = "@triggerdotdev/plugins/rbac";
      const module = await import(moduleName);
      const plugin: RoleBasedAccessControlPlugin = module.default;
      return plugin.create(helpers);
    } catch {
      return new RoleBaseAccessFallback(prisma).create(helpers);
    }
  }

  private async c(): Promise<RoleBaseAccessController> {
    return this._init;
  }

  async authenticateBearer(...args: Parameters<RoleBaseAccessController["authenticateBearer"]>) {
    const result = await (await this.c()).authenticateBearer(...args);
    return result.ok ? { ...result, ability: withActionAliases(result.ability) } : result;
  }

  async authenticateSession(...args: Parameters<RoleBaseAccessController["authenticateSession"]>) {
    const result = await (await this.c()).authenticateSession(...args);
    return result.ok ? { ...result, ability: withActionAliases(result.ability) } : result;
  }

  // Don't delegate to the underlying Authorize variants — that would run the
  // inline ability check against the unwrapped ability. Use our wrapped
  // authenticate* and do the ability check here instead.
  async authenticateAuthorizeBearer(
    request: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>[0],
    check: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>[1],
    options?: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>[2]
  ) {
    const auth = await this.authenticateBearer(request, options);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false as const, status: 403 as const, error: "Unauthorized" };
    }
    return auth;
  }

  async authenticateAuthorizeSession(
    request: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>[0],
    context: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>[1],
    check: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>[2]
  ) {
    const auth = await this.authenticateSession(request, context);
    if (!auth.ok) return auth;
    if (!auth.ability.can(check.action, check.resource)) {
      return { ok: false as const, reason: "unauthorized" as const };
    }
    return auth;
  }

  async allPermissions(...args: Parameters<RoleBaseAccessController["allPermissions"]>): Promise<Permission[]> {
    return (await this.c()).allPermissions(...args);
  }

  async allRoles(...args: Parameters<RoleBaseAccessController["allRoles"]>): Promise<Role[]> {
    return (await this.c()).allRoles(...args);
  }

  async createRole(
    ...args: Parameters<RoleBaseAccessController["createRole"]>
  ): Promise<RoleMutationResult> {
    return (await this.c()).createRole(...args);
  }

  async updateRole(
    ...args: Parameters<RoleBaseAccessController["updateRole"]>
  ): Promise<RoleMutationResult> {
    return (await this.c()).updateRole(...args);
  }

  async deleteRole(
    ...args: Parameters<RoleBaseAccessController["deleteRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).deleteRole(...args);
  }

  async getUserRole(...args: Parameters<RoleBaseAccessController["getUserRole"]>): Promise<Role | null> {
    return (await this.c()).getUserRole(...args);
  }

  async setUserRole(
    ...args: Parameters<RoleBaseAccessController["setUserRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).setUserRole(...args);
  }

  async removeUserRole(
    ...args: Parameters<RoleBaseAccessController["removeUserRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).removeUserRole(...args);
  }

  async getTokenRole(...args: Parameters<RoleBaseAccessController["getTokenRole"]>): Promise<Role | null> {
    return (await this.c()).getTokenRole(...args);
  }

  async setTokenRole(
    ...args: Parameters<RoleBaseAccessController["setTokenRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).setTokenRole(...args);
  }

  async removeTokenRole(
    ...args: Parameters<RoleBaseAccessController["removeTokenRole"]>
  ): Promise<RoleAssignmentResult> {
    return (await this.c()).removeTokenRole(...args);
  }
}

class RoleBaseAccess {
  // Synchronous — returns a lazy controller that loads the enterprise plugin on first call.
  create(
    prisma: PrismaClient,
    helpers: RbacHelpers,
    options?: RbacCreateOptions
  ): RoleBaseAccessController {
    return new LazyController(prisma, helpers, options);
  }
}

const loader = new RoleBaseAccess();

export default loader;
