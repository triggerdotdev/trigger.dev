import type { ResultAsync } from "neverthrow";

// === Domain types ===

export type SsoConnectionState = "active" | "inactive";

export type SsoDomainState = "pending" | "verified" | "failed";

export type SsoDomainStatus = {
  domain: string;
  verified: boolean;
  state: SsoDomainState;
  // Vendor-supplied reason code present when state === "failed".
  // Plugin keeps it opaque; the host UI surfaces it to the admin so
  // they know which knob to turn before retrying verification.
  verificationFailedReason: string | null;
};

export type OrgSsoStatus = {
  hasIdpOrg: boolean;
  enforced: boolean;
  jitProvisioningEnabled: boolean;
  jitDefaultRoleId: string | null;
  idpOrgId: string | null;
  primaryConnectionId: string | null;
  domains: ReadonlyArray<SsoDomainStatus>;
  connections: ReadonlyArray<{
    id: string;
    name: string | null;
    connectionType: string;
    state: SsoConnectionState;
  }>;
};

export type SsoRouteDecision =
  | { kind: "no_sso" }
  | { kind: "sso_required"; idpOrgId: string };

export const SSO_FLOWS = [
  "user_initiated",
  "auto_discovery_magic",
  "auto_discovery_oauth",
  "auto_discovery_vercel",
  "idp_initiated",
] as const;

export type SsoFlow = (typeof SSO_FLOWS)[number];

export type SsoProfile = {
  // Lowercase-normalized at the plugin / host boundary.
  email: string;
  firstName: string | null;
  lastName: string | null;
  idpSubjectId: string;
  idpOrgId: string;
  idpConnectionId: string;
};

export type SsoResolutionDecision =
  | { kind: "existing_user_by_idp"; userId: string }
  | { kind: "linked_by_email"; userId: string }
  | { kind: "create_new_user"; profile: SsoProfile };

// === Errors ===

export type SsoDecisionError = "internal";

export type SsoBeginError =
  | "no_org_for_domain"
  | "no_active_connection"
  | "feature_disabled";

export type SsoCompleteError =
  | "state_replayed_or_expired"
  | "state_invalid_signature"
  | "code_exchange_failed"
  | "org_mismatch"
  | "email_mismatch"
  | "connection_unknown";

export type SsoMutationError = "feature_disabled" | "rbac_role_invalid" | "internal";

// Vendor-neutral name for "the identity-provider organisation isn't available".
export type SsoPortalError = "idp_org_unavailable" | "internal";

// The only failure a session re-validation can report is "internal" —
// callers MUST treat it as fail-open (keep the session). An invalid
// session is NOT an error: it's a successful result of `{ valid: false }`.
export type SsoValidateError = "internal";

// Inbound webhook handling. `invalid_signature` → reject (4xx, no retry);
// `feature_disabled` → no plugin installed (host returns 404); `internal`
// → transient, the host returns 5xx so the provider retries.
export type SsoWebhookError = "invalid_signature" | "feature_disabled" | "internal";

// A verified, JSON-serializable inbound event. Vendor-neutral envelope —
// `event` is the provider's event-type string, `data` its opaque payload.
export type SsoWebhookEvent = { id: string; event: string; data: unknown };

// === Controller ===

export interface SsoController {
  // True when a real SSO plugin is loaded. Hosts gate behaviour that's
  // only meaningful when the plugin is present (e.g. rendering the
  // settings tab, registering the SSO strategy actively).
  isUsingPlugin(): Promise<boolean>;

  // --- Provisioning + admin UI ---

  getStatus(organizationId: string): ResultAsync<OrgSsoStatus, SsoDecisionError>;

  // Returns an admin-portal link the customer's IT admin uses to
  // configure their identity provider. First call also performs any lazy
  // initialization the plugin needs (no separate enable() method).
  generatePortalLink(params: {
    organizationId: string;
    userId: string;
    intent: "sso" | "domain_verification";
    returnUrl: string;
  }): ResultAsync<{ url: string }, SsoPortalError>;

  setEnforced(params: {
    organizationId: string;
    enforced: boolean;
  }): ResultAsync<void, SsoMutationError>;

  setJitProvisioningEnabled(params: {
    organizationId: string;
    enabled: boolean;
  }): ResultAsync<void, SsoMutationError>;

  setJitDefaultRole(params: {
    organizationId: string;
    roleId: string | null;
  }): ResultAsync<void, SsoMutationError>;

  // Atomic counterpart to the three setters above: the settings form
  // presents enforced + JIT-enabled + JIT-default-role as a single Save,
  // so they must commit all-or-nothing. Implementations write all three
  // OrgSsoConfig columns in one atomic write, so an `internal` failure
  // leaves none of the fields changed rather than a partially-applied
  // config. Prefer this over the individual setters for the admin Save path.
  updateConfig(params: {
    organizationId: string;
    enforced: boolean;
    jitProvisioningEnabled: boolean;
    jitDefaultRoleId: string | null;
  }): ResultAsync<void, SsoMutationError>;

  // --- Auth flow ---

  // Called by every login entry point BEFORE the strategy proceeds.
  // Composite gate (plan tier + feature flags + config + enforced) is
  // implemented here. Fail-open: returns no_sso on internal error so a
  // plugin outage doesn't lock users out.
  decideRouteForEmail(email: string): ResultAsync<SsoRouteDecision, SsoDecisionError>;

  // Returns the URL the user should be redirected to in order to
  // authenticate with their identity provider. Internally mints a
  // single-use signed state token; the implementation is opaque to
  // OSS callers. Email is lowercase-normalized before lookup.
  beginAuthorization(params: {
    email: string;
    redirectTo: string;
    flow: SsoFlow;
  }): ResultAsync<{ url: string }, SsoBeginError>;

  // SP-initiated callback. Verifies and consumes the signed state token
  // single-use, exchanges the code with the SSO provider, cross-checks
  // the returned profile against the state claims. Returns profile +
  // state-carried redirectTo + flow.
  completeAuthorization(params: {
    code: string;
    state: string;
  }): ResultAsync<{ profile: SsoProfile; redirectTo: string; flow: SsoFlow }, SsoCompleteError>;

  // IdP-initiated callback (no state). Validates the returned connection
  // identifier is one of ours. Default redirectTo is "/".
  completeIdpInitiatedAuthorization(params: {
    code: string;
  }): ResultAsync<{ profile: SsoProfile; redirectTo: string }, SsoCompleteError>;

  // Re-validate a live SSO session against the IdP. Called periodically
  // (throttled by the host) for sessions that were established via SSO.
  // The available signal is whether the user's identity-provider
  // connection is still active, so `valid` reflects that. Returns an
  // `internal` error on any infrastructure failure (e.g. the identity
  // provider is unreachable) — the host MUST fail-open on the error and
  // only invalidate the session on an explicit `{ valid: false }`.
  validateSession(params: {
    userId: string;
    idpOrgId: string;
    connectionId: string;
  }): ResultAsync<{ valid: boolean }, SsoValidateError>;

  // Look up an existing identity by IdP subject, or by lowercased email.
  // Returns a decision the OSS callback handler uses to drive
  // User/OrgMember writes. The plugin DOES NOT write to OSS public.*
  // tables — those writes are the host's responsibility.
  resolveSsoIdentity(params: {
    profile: SsoProfile;
  }): ResultAsync<SsoResolutionDecision, SsoMutationError>;

  // After the host has created/found the User row, the plugin attaches
  // the IdP identity row in its own storage.
  attachSsoIdentity(params: {
    userId: string;
    profile: SsoProfile;
  }): ResultAsync<void, SsoMutationError>;

  // Returns whether JIT should provision a membership for the given
  // (userId, idpOrgId), and the resolved roleId to assign (the org's
  // JIT default role, or null when no RBAC plugin is installed).
  // The host performs the actual OrgMember insert.
  evaluateJit(params: {
    userId: string;
    idpOrgId: string;
  }): ResultAsync<
    { shouldProvision: boolean; organizationId: string; roleId: string | null },
    SsoMutationError
  >;

  // --- Inbound webhooks ---

  // Verify the signature of a raw inbound webhook request and return the
  // parsed, JSON-serializable event. The host forwards the raw body +
  // headers from a thin proxy route; the plugin owns the vendor-specific
  // signature scheme. The host enqueues the returned event for async
  // processing (it never enqueues an unverified request).
  verifyWebhook(params: {
    rawBody: string;
    headers: Record<string, string>;
  }): ResultAsync<{ event: SsoWebhookEvent }, SsoWebhookError>;

  // Process a previously-verified webhook event (the host's background
  // worker calls this). Performs the plugin's own state writes; throws
  // nothing — failures surface as `internal` so the worker retries.
  processWebhookEvent(event: SsoWebhookEvent): ResultAsync<void, SsoWebhookError>;
}

export interface SsoPlugin {
  create(): SsoController | Promise<SsoController>;
}
