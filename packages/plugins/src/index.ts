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
  UserActorAuthResult,
  UserActorClaims,
  RbacPluginConfig,
  RbacDatabaseConfig,
  SystemRole,
  AuthenticatedEnvironment,
} from "./rbac.js";

export { buildJwtAbility } from "./rbac.js";
export {
  isUserActorToken,
  signUserActorToken,
  verifyUserActorToken,
  USER_ACTOR_TOKEN_PREFIX,
} from "./rbac.js";

export type { PluginDatabaseConfig } from "./databaseConfig.js";

export type {
  SsoPlugin,
  SsoPluginConfig,
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
  DirectoryState,
  DirectoryGroupMapping,
  DirectorySyncStatus,
  DirectorySyncEffect,
} from "./sso.js";

export { SSO_FLOWS } from "./sso.js";
