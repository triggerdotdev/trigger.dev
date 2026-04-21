import type { PrismaClient } from "@trigger.dev/database";

export type { PrismaClient };

export type Permission = {
  name: string;
  description: string;
};

export type Role = {
  name: string;
  description: string;
  permissions: Permission[];
};

export interface RoleBaseAccessController {
  allPermissions(): Promise<Permission[]>;
  allRoles(): Promise<Role[]>;
}

export interface RoleBasedAccessControlPlugin {
  create(prisma: PrismaClient): RoleBaseAccessController | Promise<RoleBaseAccessController>;
}
