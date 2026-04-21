import type {
  Permission,
  Role,
  RoleBaseAccessController,
  RoleBasedAccessControlPlugin,
} from "@trigger.dev/plugins";

export class RoleBaseAccessFallback implements RoleBasedAccessControlPlugin {
  async create() {
    return new RoleBaseAccessFallbackController();
  }
}

const accountWildcard: Permission = {
  name: "*:account",
  description: "Full abilities for an account",
};

const superWildcard: Permission = {
  name: "*:super",
  description: "Full abilities for a super user",
};

const owner: Role = {
  name: "owner",
  description: "Full access to all features",
  permissions: [accountWildcard, superWildcard],
};

const superAdmin: Role = {
  name: "super_admin",
  description: "Full access to all features and the ability to manage the Trigger.dev platform",
  permissions: [accountWildcard, superWildcard],
};

class RoleBaseAccessFallbackController implements RoleBaseAccessController {
  async allPermissions(): Promise<Permission[]> {
    return [owner, superAdmin];
  }

  async allRoles(): Promise<Role[]> {
    return [owner, superAdmin];
  }
}
