import type {
  OrgSsoStatus,
  SsoBeginError,
  SsoCompleteError,
  SsoController,
  SsoDecisionError,
  SsoMutationError,
  SsoPortalError,
  SsoProfile,
  SsoResolutionDecision,
  SsoRouteDecision,
  SsoValidateError,
  SsoWebhookError,
  SsoWebhookEvent,
} from "@trigger.dev/plugins";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

// The default fallback used when no cloud SSO plugin is installed.
// `decideRouteForEmail` returns no_sso so OSS deployments behave
// identically to a deployment with no SSO feature at all. Mutation
// methods return feature_disabled so callers can surface a clear
// "not available" message in UI gated by `isUsingPlugin()`.
//
// The fallback never touches the database. It still accepts the loader's
// Prisma input for signature parity with the real cloud plugin factory
// (so the loader can swap implementations without changing its call),
// but ignores it entirely.
export class SsoFallback {
  constructor(_prisma?: unknown) {}

  create(): SsoController {
    return new SsoFallbackController();
  }
}

class SsoFallbackController implements SsoController {
  async isUsingPlugin(): Promise<boolean> {
    return false;
  }

  getStatus(_organizationId: string): ResultAsync<OrgSsoStatus, SsoDecisionError> {
    return okAsync({
      hasIdpOrg: false,
      enforced: false,
      jitProvisioningEnabled: false,
      jitDefaultRoleId: null,
      idpOrgId: null,
      primaryConnectionId: null,
      domains: [],
      connections: [],
    });
  }

  generatePortalLink(_params: {
    organizationId: string;
    userId: string;
    intent: "sso" | "domain_verification";
    returnUrl: string;
  }): ResultAsync<{ url: string }, SsoPortalError> {
    return errAsync("idp_org_unavailable" as const);
  }

  setEnforced(_params: {
    organizationId: string;
    enforced: boolean;
  }): ResultAsync<void, SsoMutationError> {
    return errAsync("feature_disabled" as const);
  }

  setJitProvisioningEnabled(_params: {
    organizationId: string;
    enabled: boolean;
  }): ResultAsync<void, SsoMutationError> {
    return errAsync("feature_disabled" as const);
  }

  setJitDefaultRole(_params: {
    organizationId: string;
    roleId: string | null;
  }): ResultAsync<void, SsoMutationError> {
    return errAsync("feature_disabled" as const);
  }

  updateConfig(_params: {
    organizationId: string;
    enforced: boolean;
    jitProvisioningEnabled: boolean;
    jitDefaultRoleId: string | null;
  }): ResultAsync<void, SsoMutationError> {
    return errAsync("feature_disabled" as const);
  }

  decideRouteForEmail(_email: string): ResultAsync<SsoRouteDecision, SsoDecisionError> {
    return okAsync({ kind: "no_sso" as const });
  }

  beginAuthorization(_params: {
    email: string;
    redirectTo: string;
    flow: import("@trigger.dev/plugins").SsoFlow;
  }): ResultAsync<{ url: string }, SsoBeginError> {
    return errAsync("feature_disabled" as const);
  }

  completeAuthorization(_params: {
    code: string;
    state: string;
  }): ResultAsync<
    {
      profile: SsoProfile;
      redirectTo: string;
      flow: import("@trigger.dev/plugins").SsoFlow;
    },
    SsoCompleteError
  > {
    return errAsync("connection_unknown" as const);
  }

  completeIdpInitiatedAuthorization(_params: {
    code: string;
  }): ResultAsync<{ profile: SsoProfile; redirectTo: string }, SsoCompleteError> {
    return errAsync("connection_unknown" as const);
  }

  // Fail-open: with no plugin there are no SSO sessions to invalidate,
  // and the host treats `valid: true` as "leave the session alone".
  validateSession(_params: {
    userId: string;
    idpOrgId: string;
    connectionId: string;
  }): ResultAsync<{ valid: boolean }, SsoValidateError> {
    return okAsync({ valid: true });
  }

  resolveSsoIdentity(_params: {
    profile: SsoProfile;
  }): ResultAsync<SsoResolutionDecision, SsoMutationError> {
    return errAsync("feature_disabled" as const);
  }

  attachSsoIdentity(_params: {
    userId: string;
    profile: SsoProfile;
  }): ResultAsync<void, SsoMutationError> {
    return errAsync("feature_disabled" as const);
  }

  evaluateJit(_params: {
    userId: string;
    idpOrgId: string;
  }): ResultAsync<
    { shouldProvision: boolean; organizationId: string; roleId: string | null },
    SsoMutationError
  > {
    return errAsync("feature_disabled" as const);
  }

  verifyWebhook(_params: {
    rawBody: string;
    headers: Record<string, string>;
  }): ResultAsync<{ event: SsoWebhookEvent }, SsoWebhookError> {
    return errAsync("feature_disabled" as const);
  }

  processWebhookEvent(_event: SsoWebhookEvent): ResultAsync<void, SsoWebhookError> {
    return errAsync("feature_disabled" as const);
  }
}
