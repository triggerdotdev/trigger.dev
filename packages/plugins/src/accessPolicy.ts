import type { PluginDatabaseConfig } from "./databaseConfig.js";

/**
 * Deployment-specific rules for who may sign in, keep a session, or join an organization, plus
 * operator actions on an organization. Without a plugin every check passes and there are no
 * operator actions. A check that throws is treated by the host as a refusal.
 */

export type SignInCheck = {
  email: string;
  /** The host's own domain rules refuse this address. The plugin may still allow it. */
  domainBlocked: boolean;
};
export type SignInDecision = { allowed: true } | { allowed: false };

export type SessionCheck = {
  userId: string;
  /** When the session was issued, ms since epoch. Absent for sessions that predate stamping. */
  issuedAt?: number;
};
export type SessionDecision =
  | {
      valid: true;
      /**
       * The user's session deadline, when the plugin read it alongside its own check so the
       * host need not. Omitted (or any of the three fields omitted): the host reads them itself.
       */
      nextSessionEnd?: Date | null;
      /** The user's `sessionsValidAfter`, read alongside `nextSessionEnd`. */
      sessionsValidAfter?: Date | null;
      /** The user's `revokedSessions`, read alongside `nextSessionEnd`. */
      revokedSessions?: Date[];
    }
  | { valid: false };

export type OrganizationJoinCheck = { organizationId: string };
export type OrganizationJoinDecision = { allowed: true } | { allowed: false };

/** A field the operator fills in before an action runs. */
export type AdminActionField = {
  name: string;
  label: string;
  kind: "text" | "textarea";
  /** The field must equal this value, typed by the operator as confirmation. */
  mustEqual?: string;
  required?: boolean;
};

export type AdminAction = {
  intent: string;
  label: string;
  variant: "primary" | "secondary" | "danger";
  /** Shown above the fields before the operator confirms. */
  warning?: string;
  fields: AdminActionField[];
};

/** A section the host renders on an organization's back-office page. */
export type AdminPanel = {
  title: string;
  /** Read-only facts shown in the section. */
  properties: { label: string; value: string }[];
  actions: AdminAction[];
};

export type AdminActionInput = {
  organizationId: string;
  /** The host has verified this user is an instance admin. */
  adminUserId: string;
  intent: string;
  fields: Record<string, string>;
};

export type AdminActionResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string[] | undefined> };

export interface AccessPolicyController {
  /** Runs before a sign-in or sign-up is accepted. Decides for the host's own domain rules too. */
  checkSignIn(check: SignInCheck): Promise<SignInDecision>;
  /** Runs on every authenticated request and at sign-in. An invalid session is ended. */
  checkSession(check: SessionCheck): Promise<SessionDecision>;
  /** Runs before a user accepts an invitation. */
  checkOrganizationJoin(check: OrganizationJoinCheck): Promise<OrganizationJoinDecision>;
  /** The subset of these organizations whose support access the host must treat as allowed. */
  forcedSupportAccess(organizationIds: string[]): Promise<string[]>;
  /** Null when the plugin has nothing to show for this organization. */
  organizationAdminPanel(organizationId: string): Promise<AdminPanel | null>;
  performOrganizationAdminAction(input: AdminActionInput): Promise<AdminActionResult>;
}

export type EnvironmentPauseState = { paused: boolean; pauseSource: string | null };

/**
 * What an organization ban rotated and revoked, for the host's audit log. Ids, names and last 4s
 * only: never a key, a token or its hash. Org access tokens are left out: only the platform makes
 * them, and customers never see them.
 */
export type AccessPolicyBanCredentialChanges = {
  organizationId: string;
  bannedAt: Date;
  /** The Trigger.dev staff member who banned the organization. */
  staffUserId: string;
  rotatedRootKeys: {
    environmentId: string;
    projectId: string;
    environmentType: string;
    previousKeyLast4: string;
    newKeyLast4: string;
  }[];
  /** Root keys rotated before the ban that still worked in their grace period, until the ban. */
  graceEndedRootKeys: {
    environmentId: string;
    projectId: string;
    environmentType: string;
    keyLast4: string;
  }[];
  /** Only the keys and tokens that still worked: expired ones changed nothing for the customer. */
  revokedApiKeys: {
    id: string;
    name: string;
    last4: string;
    environmentId: string;
    projectId: string;
    environmentType: string;
  }[];
  revokedPersonalAccessTokens: { id: string; name: string; last4: string; userId: string }[];
};

export type AccessPolicyPluginConfig = {
  database: PluginDatabaseConfig;
  /** New root keys for an environment of this type, in the host's key format. */
  generateRootApiKeys(environmentType: string): Promise<{ apiKey: string; pkApiKey: string }>;
  /** Cancels every run the organization has that can still be cancelled. Idempotent per dedupeKey. */
  cancelOrganizationRuns(
    organizationId: string,
    dedupeKey: string
  ): Promise<{ bulkActionIds: string[] }>;
  /** Pushes an environment's concurrency limit to the run queue; undefined re-reads it from the database. */
  syncEnvironmentLimit(environmentId: string, limit: number | undefined): Promise<void>;
  /** Drops the host's cached copies of the organization and these environments. */
  invalidateCaches(organizationId: string, environmentIds: string[]): Promise<void>;
  /**
   * The pause state the host's billing rules want for environments of this type. "unknown" when
   * billing can't be reached.
   */
  billingPauseState(
    organizationId: string,
    environmentType: string
  ): Promise<EnvironmentPauseState | "unknown">;
  /**
   * Records a committed ban's credential changes in the audit log. Called once per ban, alongside
   * the fingerprint marks; a host without it records nothing. A rejection is logged, never thrown.
   */
  onBanCredentialsChanged?(changes: AccessPolicyBanCredentialChanges): Promise<void>;
};

export interface AccessPolicyPlugin {
  create(config: AccessPolicyPluginConfig): AccessPolicyController;
}
