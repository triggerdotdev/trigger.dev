import type { PluginDatabaseConfig } from "./databaseConfig.js";

type AuditLogActionsByCategory = {
  credentials:
    | "api_key.created"
    | "api_key.rotated"
    | "api_key.revoked"
    | "api_key.root_visibility_disabled"
    | "api_key.ip_ranges_updated"
    | "api_key.grace_extended"
    | "api_key.access_changed"
    | "pat.created"
    | "pat.revoked";
  envvars:
    | "envvar.created"
    | "envvar.updated"
    | "envvar.value_updated"
    | "envvar.deleted"
    | "envvar.imported"
    | "envvar.listed"
    | "envvar.read";
  members:
    | "member.invited"
    | "invite.revoked"
    | "invite.accepted"
    | "member.removed"
    | "member.role_changed";
  support: "support.session_started" | "support.session_ended";
  /** Never returned by `listEvents`. */
  auth: "auth.credential_rejected";
};

export type AuditLogCategory = keyof AuditLogActionsByCategory;

export type AuditLogAction = AuditLogActionsByCategory[AuditLogCategory];

export type AuditLogActorType =
  | "user"
  | "api_key"
  | "pat"
  | "oat"
  | "support"
  /** Task code in a run, authenticated with the run's token. `id` is the run id. */
  | "run"
  | "trigger_infra"
  | "system";

/** `id` is a row id (user, key, token, run), never a secret. Null for `system`. */
export type AuditLogActor = {
  type: AuditLogActorType;
  id: string | null;
};

export type AuditLogCredentialKind =
  | "root_api_key"
  | "additional_api_key"
  | "public_jwt"
  | "run_token"
  | "pat"
  | "oat";

/** The credential a request used. Never the credential value. */
export type AuditLogCredential = {
  kind: AuditLogCredentialKind;
  id: string | null;
  last4: string | null;
  /** Stable id of the credential's fingerprint. Never returned by `listEvents`. */
  fingerprintId: string | null;
};

export type AuditLogSource = "dashboard" | "api" | "cli" | "run" | "staff";

export type AuditLogEnvironmentType = "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";

export type AuditLogTarget = {
  type: string;
  id: string | null;
  name: string | null;
};

export type AuditLogEndpoint = {
  ip: string | null;
  userAgent: string | null;
};

/** Set when Trigger.dev infrastructure acted, e.g. the build server for a deployment. */
export type AuditLogOrigin = {
  deploymentId: string;
};

type AuditLogChangeScalar = string | number | boolean | null;

/** Small and non-secret: key names, roles, last 4 characters. Never secret values. */
export type AuditLogChanges = Record<
  string,
  AuditLogChangeScalar | { before: AuditLogChangeScalar; after: AuditLogChangeScalar }
>;

type AuditLogEventFor<C extends AuditLogCategory> = {
  category: C;
  action: AuditLogActionsByCategory[C];
};

type AuditLogCategoryAndAction = {
  [C in AuditLogCategory]: AuditLogEventFor<C>;
}[AuditLogCategory];

/** What the caller knows about the change. Who made it and from where comes from the context. */
export type AuditLogInput = AuditLogCategoryAndAction & {
  organizationId: string;
  projectId?: string | null;
  environmentId?: string | null;
  environmentType?: AuditLogEnvironmentType | null;
  target: AuditLogTarget;
  changes?: AuditLogChanges | null;
  /** Overrides the context's actor, e.g. `system` for changes made by directory sync. */
  actor?: AuditLogActor;
};

/** What the host knows about the call that made the change. Unknown fields are null. */
export type AuditLogContext = {
  occurredAt: Date;
  actor: AuditLogActor | null;
  credential: AuditLogCredential | null;
  /** The user acting on behalf of the actor, e.g. during impersonation. Never returned by `listEvents`. */
  onBehalfOf: { userId: string } | null;
  source: AuditLogSource | null;
  endpoint: AuditLogEndpoint | null;
  origin: AuditLogOrigin | null;
  requestId: string | null;
};

type AuditLogEventFields = {
  /** Unique per event. */
  id: string;
  occurredAt: Date;
  organizationId: string;
  projectId: string | null;
  environmentId: string | null;
  environmentType: AuditLogEnvironmentType | null;
  target: AuditLogTarget;
  actor: AuditLogActor;
  credential: AuditLogCredential | null;
  /** The user acting on behalf of the actor, e.g. during impersonation. Never returned by `listEvents`. */
  onBehalfOf: { userId: string } | null;
  source: AuditLogSource;
  endpoint: AuditLogEndpoint | null;
  origin: AuditLogOrigin | null;
  requestId: string | null;
  changes: AuditLogChanges | null;
};

export type AuditLogEvent = AuditLogCategoryAndAction & AuditLogEventFields;

/** Categories `listEvents` returns: every category but `auth`. */
export type AuditLogListedCategory = Exclude<AuditLogCategory, "auth">;

export type AuditLogListedAction = AuditLogActionsByCategory[AuditLogListedCategory];

type AuditLogListedCategoryAndAction = {
  [C in AuditLogListedCategory]: AuditLogEventFor<C>;
}[AuditLogListedCategory];

/** An event as `listEvents` returns it: no `onBehalfOf`, no credential `fingerprintId`. */
export type AuditLogListedEvent = AuditLogListedCategoryAndAction &
  Omit<AuditLogEventFields, "onBehalfOf" | "credential"> & {
    credential: Omit<AuditLogCredential, "fingerprintId"> | null;
  };

export type AuditLogEventQuery = {
  organizationId: string;
  /** Inclusive. The host passes the start of the organization's visibility window or later. */
  from: Date;
  /** Exclusive. */
  to: Date;
  categories?: AuditLogListedCategory[];
  actions?: AuditLogListedAction[];
  actorId?: string;
  projectId?: string;
  environmentId?: string;
  /** Matches events involving a credential whose last 4 characters are these. */
  keyLast4?: string;
  /** From the previous page's `nextCursor`. */
  cursor?: string;
  limit: number;
};

export type AuditLogEventPage = {
  events: AuditLogListedEvent[];
  /** Null on the last page. */
  nextCursor: string | null;
};

/** Credentials that get a fingerprint. Public JWTs and run tokens are attributed to the key behind them. */
export type AuditLogFingerprintedCredentialKind = Exclude<
  AuditLogCredentialKind,
  "public_jwt" | "run_token"
>;

export type AuditLogCredentialFingerprintInput = {
  /** SHA-256 hex of the credential value, as `hashApiKey` / `hashToken` produce it. */
  hash: string;
  kind: AuditLogFingerprintedCredentialKind;
  /** Null for personal access tokens, which belong to a user rather than an organization. */
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  /** Row id of the credential, when it has one. */
  credentialId: string | null;
  name: string | null;
  last4: string;
  createdBy: AuditLogActor | null;
  /** Null when unknown: a credential fingerprinted after it was created, e.g. by a backfill. */
  createdAt: Date | null;
  expiresAt: Date | null;
};

export type AuditLogCredentialRevokeReason =
  | "rotated"
  | "rotated_immediately"
  | "hidden"
  | "member_removed"
  | "banned"
  | "revoked";

export type AuditLogCredentialRevokedInput = {
  /** Hash of the credential being revoked. */
  hash: string;
  revokedAt: Date;
  revokedBy: AuditLogActor | null;
  reason: AuditLogCredentialRevokeReason;
  /** When a rotated credential stops working, if it keeps working for a grace period. */
  graceUntil: Date | null;
  /** Hash of the credential that replaced it, for rotations. */
  replacedByHash: string | null;
};

/** Where the plugin stores events is its own concern; the host only shares the control plane. */
export type AuditLogPluginConfig = {
  /** The control-plane database, where credential fingerprints live. */
  controlPlane: PluginDatabaseConfig;
};

export interface AuditLogController {
  /**
   * Records a change. The host calls it after the change commits, never inside a transaction
   * callback, so a rolled-back change is never recorded. Never throws: an event that can't be
   * stored is dropped and counted.
   */
  record(input: AuditLogInput, context: AuditLogContext): Promise<void>;
  /** Resolves when every recorded event has been handled. For tests and shutdown. */
  flush(): Promise<void>;
  /**
   * Saves a new credential's fingerprint. The host calls it before the change that creates the
   * credential commits, and fails the change when this throws. Null when this deployment stores
   * no fingerprints.
   */
  saveCredentialFingerprint(
    input: AuditLogCredentialFingerprintInput
  ): Promise<{ fingerprintId: string } | null>;
  /** Marks a credential's fingerprint revoked. The host calls it after the revocation commits. */
  markCredentialRevoked(input: AuditLogCredentialRevokedInput): Promise<void>;
  /**
   * Moves the grace period of a credential already marked revoked, e.g. when support extends it.
   * Changes nothing else, and leaves a credential that was never marked revoked alone.
   */
  updateCredentialGrace(hash: string, graceUntil: Date | null): Promise<void>;
  /** Looks up a fingerprint by credential hash. Called on the request path, so it should be cheap. */
  findCredentialFingerprint(hash: string): Promise<{ fingerprintId: string } | null>;
  /**
   * Events for one organization, newest first. Never returns `auth` events. The host
   * copies only the listed fields out of each event before returning it.
   */
  listEvents(query: AuditLogEventQuery): Promise<AuditLogEventPage>;
}

export interface AuditLogPlugin {
  create(config: AuditLogPluginConfig): AuditLogController;
}
