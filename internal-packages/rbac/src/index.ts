import type {
  Permission,
  Role,
  RbacResource,
  RoleBaseAccessController,
  RoleBasedAccessControlPlugin,
} from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { RoleBaseAccessFallback } from "./fallback.js";
export type { RoleBaseAccessController };

type RbacHelpers = { getSessionUserId: (request: Request) => Promise<string | null> };

export type RbacCreateOptions = {
  // When true, skip loading the enterprise plugin and use the OSS fallback directly.
  // Useful for tests that need deterministic auth behavior without the enterprise plugin.
  forceFallback?: boolean;
};

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
    return (await this.c()).authenticateBearer(...args);
  }

  async authenticateSession(...args: Parameters<RoleBaseAccessController["authenticateSession"]>) {
    return (await this.c()).authenticateSession(...args);
  }

  async authenticateAuthorizeBearer(...args: Parameters<RoleBaseAccessController["authenticateAuthorizeBearer"]>) {
    return (await this.c()).authenticateAuthorizeBearer(...args);
  }

  async authenticateAuthorizeSession(...args: Parameters<RoleBaseAccessController["authenticateAuthorizeSession"]>) {
    return (await this.c()).authenticateAuthorizeSession(...args);
  }

  async allPermissions(...args: Parameters<RoleBaseAccessController["allPermissions"]>): Promise<Permission[]> {
    return (await this.c()).allPermissions(...args);
  }

  async allRoles(...args: Parameters<RoleBaseAccessController["allRoles"]>): Promise<Role[]> {
    return (await this.c()).allRoles(...args);
  }

  async createRole(...args: Parameters<RoleBaseAccessController["createRole"]>): Promise<Role> {
    return (await this.c()).createRole(...args);
  }

  async updateRole(...args: Parameters<RoleBaseAccessController["updateRole"]>): Promise<Role> {
    return (await this.c()).updateRole(...args);
  }

  async deleteRole(...args: Parameters<RoleBaseAccessController["deleteRole"]>): Promise<void> {
    return (await this.c()).deleteRole(...args);
  }

  async getUserRole(...args: Parameters<RoleBaseAccessController["getUserRole"]>): Promise<Role | null> {
    return (await this.c()).getUserRole(...args);
  }

  async setUserRole(...args: Parameters<RoleBaseAccessController["setUserRole"]>): Promise<void> {
    return (await this.c()).setUserRole(...args);
  }

  async removeUserRole(...args: Parameters<RoleBaseAccessController["removeUserRole"]>): Promise<void> {
    return (await this.c()).removeUserRole(...args);
  }

  async getTokenRole(...args: Parameters<RoleBaseAccessController["getTokenRole"]>): Promise<Role | null> {
    return (await this.c()).getTokenRole(...args);
  }

  async setTokenRole(...args: Parameters<RoleBaseAccessController["setTokenRole"]>): Promise<void> {
    return (await this.c()).setTokenRole(...args);
  }

  async removeTokenRole(...args: Parameters<RoleBaseAccessController["removeTokenRole"]>): Promise<void> {
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
