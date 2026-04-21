import type {
  RoleBaseAccessController,
  RoleBasedAccessControlPlugin,
  PrismaClient,
} from "@trigger.dev/plugins";
import { RoleBaseAccessFallback } from "./fallback";
export type { RoleBaseAccessController, RoleBasedAccessControlPlugin };

class RoleBaseAccess implements RoleBasedAccessControlPlugin {
  async create(prisma: PrismaClient) {
    try {
      const moduleName = "@triggerdotdev/plugin-rbac";
      const module = await import(moduleName);
      const { create } = await module();
      return create(prisma);
    } catch {
      const fallback = new RoleBaseAccessFallback();
      return fallback.create();
    }
  }
}

const plugin = new RoleBaseAccess();

export default plugin;
