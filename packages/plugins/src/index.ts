export type {
  RoleBasedAccessControlPlugin,
  RoleBaseAccessController,
  RoleAssignmentResult,
  RoleMutationResult,
  Permission,
  Role,
  RbacAbility,
  RbacSubject,
  RbacResource,
  RbacEnvironment,
  RbacUser,
  BearerAuthResult,
  SessionAuthResult,
  PatAuthResult,
  SystemRole,
  AuthenticatedEnvironment,
} from "./rbac.js";

export { buildJwtAbility } from "./rbac.js";

// Convenience re-exports — give plugin authors one import surface
// without reaching into @trigger.dev/core directly. Both helpers live in
// core; this is purely a forwarder.
export { sanitizeBranchName, isValidGitBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
