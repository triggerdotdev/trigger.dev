import type {
  RoleBaseAccessController,
  RoleBasedAccessControlPlugin,
} from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import { RoleBaseAccessFallback } from "./fallback.js";
export type { RoleBaseAccessController };

type RbacHelpers = { getSessionUserId: (request: Request) => Promise<string | null> };

class RoleBaseAccess {
  async create(prisma: PrismaClient, helpers: RbacHelpers): Promise<RoleBaseAccessController> {
    try {
      const moduleName = "@triggerdotdev/plugins/rbac";
      const module = await import(moduleName);
      const plugin: RoleBasedAccessControlPlugin = module.default;
      return plugin.create(helpers);
    } catch {
      return new RoleBaseAccessFallback(prisma).create(helpers);
    }
  }
}

const loader = new RoleBaseAccess();

export default loader;
