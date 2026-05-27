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

export type {
  SsoPlugin,
  SsoController,
  OrgSsoStatus,
  SsoRouteDecision,
  SsoFlow,
  SsoProfile,
  SsoConnectionState,
  SsoDomainState,
  SsoDomainStatus,
  SsoResolutionDecision,
  SsoDecisionError,
  SsoBeginError,
  SsoCompleteError,
  SsoMutationError,
  SsoPortalError,
  SsoValidateError,
  SsoWebhookError,
  SsoWebhookEvent,
} from "./sso.js";

export { SSO_FLOWS } from "./sso.js";

// Convenience re-exports — gives plugin authors (and the cloud workspace
// link) one import surface without reaching into @trigger.dev/core
// directly. Both helpers live in core; this is purely a forwarder.
export { sanitizeBranchName, isValidGitBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
