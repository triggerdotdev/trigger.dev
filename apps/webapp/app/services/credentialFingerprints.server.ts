import type {
  AuditLogActor,
  AuditLogCredentialFingerprintInput,
  AuditLogCredentialRevokeReason,
  AuditLogFingerprintedCredentialKind,
} from "@trigger.dev/plugins";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { hashApiKey } from "~/utils/apiKeys";

// Credential fingerprints give every credential a stable, non-secret identity for audit logs.
// Save a new credential's fingerprint before the change that creates it commits, and let a failure
// fail the change. Mark a credential revoked after the revocation commits: marks run in the
// background and never fail the change. All of these are no-ops without the audit log plugin.
// Never pass these helpers' work into a transaction callback.

type CredentialOwner = {
  /** Null for personal access tokens, which belong to a user rather than an organization. */
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
};

/**
 * False without the audit log plugin. Lets a caller skip work done only for a fingerprint.
 */
export async function isCredentialFingerprintingEnabled(): Promise<boolean> {
  return auditLogs.isFingerprintingEnabled();
}

export function userActor(userId: string): AuditLogActor {
  return { type: "user", id: userId };
}

export const SYSTEM_ACTOR: AuditLogActor = { type: "system", id: null };

/** Saves the fingerprint of a credential that is about to be created. Throws on failure. */
export async function saveCredentialFingerprint(
  credential: CredentialOwner & {
    kind: AuditLogFingerprintedCredentialKind;
    /** The credential value. Only its hash and last 4 characters leave this function. */
    value: string;
    credentialId?: string | null;
    name?: string | null;
    createdBy: AuditLogActor | null;
    expiresAt?: Date | null;
  }
): Promise<void> {
  await auditLogs.saveCredentialFingerprint({
    hash: hashApiKey(credential.value),
    kind: credential.kind,
    organizationId: credential.organizationId,
    projectId: credential.projectId,
    environmentId: credential.environmentId,
    credentialId: credential.credentialId ?? null,
    name: credential.name ?? null,
    last4: credential.value.slice(-4),
    createdBy: credential.createdBy,
    createdAt: new Date(),
    expiresAt: credential.expiresAt ?? null,
  });
}

export function saveRootApiKeyFingerprint(
  apiKey: string,
  environment: { organizationId: string; projectId: string; id: string },
  createdBy: AuditLogActor | null
): Promise<void> {
  return saveCredentialFingerprint({
    kind: "root_api_key",
    value: apiKey,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    createdBy,
  });
}

export type CredentialRevocation = {
  revokedBy: AuditLogActor | null;
  reason: AuditLogCredentialRevokeReason;
  revokedAt?: Date;
  /** When the credential stops working, if it keeps working for a grace period. */
  graceUntil?: Date | null;
};

type RootApiKeyEnvironment = { organizationId: string; projectId: string; id: string };

/**
 * The fingerprint of a root key, to pass as `saveFirst`. `createdAt` is null when unknown: a key
 * that is being revoked may predate fingerprints.
 */
function rootApiKeyFingerprint(
  apiKey: string,
  environment: RootApiKeyEnvironment,
  created: { createdBy: AuditLogActor | null; createdAt: Date | null }
): AuditLogCredentialFingerprintInput {
  return {
    hash: hashApiKey(apiKey),
    kind: "root_api_key",
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    credentialId: null,
    name: null,
    last4: apiKey.slice(-4),
    createdBy: created.createdBy,
    createdAt: created.createdAt,
    expiresAt: null,
  };
}

/**
 * Marks a credential, identified by its value, revoked. `saveFirst` fingerprints are saved, in
 * order, before the mark. Runs in the background; never throws.
 */
function markCredentialRevoked(
  value: string,
  revocation: CredentialRevocation & { replacedBy?: string | null },
  saveFirst: AuditLogCredentialFingerprintInput[] = []
): void {
  markCredentialHashRevoked(
    hashApiKey(value),
    {
      ...revocation,
      replacedByHash: revocation.replacedBy ? hashApiKey(revocation.replacedBy) : null,
    },
    saveFirst
  );
}

/**
 * Moves the grace period of a credential, identified by its value, that was already marked
 * revoked. Changes nothing else. Runs in the background; never throws.
 */
export function updateCredentialGrace(value: string, graceUntil: Date | null): void {
  auditLogs.updateCredentialGrace(hashApiKey(value), graceUntil);
}

/**
 * Marks a credential, identified by its stored hash, revoked. `saveFirst` fingerprints are saved,
 * in order, before the mark. Runs in the background; never throws.
 */
export function markCredentialHashRevoked(
  hash: string,
  revocation: CredentialRevocation & { replacedByHash?: string | null },
  saveFirst: AuditLogCredentialFingerprintInput[] = []
): void {
  auditLogs.markCredentialRevoked(
    {
      hash,
      revokedAt: revocation.revokedAt ?? new Date(),
      revokedBy: revocation.revokedBy,
      reason: revocation.reason,
      graceUntil: revocation.graceUntil ?? null,
      replacedByHash: revocation.replacedByHash ?? null,
    },
    { saveFirst }
  );
}

/**
 * Marks a root key revoked, first saving its fingerprint if it has none: a key created before
 * fingerprints has no row, and a mark only updates an existing row. When and by whom it was
 * created are unknown, so they are null; a key that already has a row keeps its own. Call after
 * the revocation commits. Runs in the background; never throws.
 */
export function markRootApiKeyRevoked(
  apiKey: string,
  environment: RootApiKeyEnvironment,
  revocation: CredentialRevocation & { replacedBy?: string | null }
): void {
  markCredentialRevoked(apiKey, revocation, [
    rootApiKeyFingerprint(apiKey, environment, { createdBy: null, createdAt: null }),
  ]);
}

export type MemberRemovalCredentials = {
  organizationId: string;
  rotatedRootApiKeys: {
    environmentId: string;
    projectId: string;
    previousApiKey: string;
    apiKey: string;
    /** False for a key made inside the removal, whose fingerprint is saved after commit. */
    fingerprintSaved: boolean;
  }[];
  revokedApiKeys: {
    id: string;
    name: string;
    lastFour: string;
    keyHash: string;
    environmentId: string;
    projectId: string;
  }[];
};

/**
 * Records the credentials a member removal rotated and revoked. Call after the removal commits.
 * For each environment, saves the new key's fingerprint if it was made inside the removal (an
 * environment created after the keys were prepared) and the old key's if it has none, then marks
 * the old key revoked. Runs in the background; never throws. `actor` made the removal: it created
 * the new keys and revoked the old ones.
 */
export function recordMemberRemovalCredentials(
  credentials: MemberRemovalCredentials,
  actor: AuditLogActor | null
): void {
  const revocation = { revokedBy: actor, reason: "member_removed" } as const;
  for (const rotated of credentials.rotatedRootApiKeys) {
    const environment = {
      id: rotated.environmentId,
      organizationId: credentials.organizationId,
      projectId: rotated.projectId,
    };
    // The new key is saved before the old one is marked, so the mark can name its replacement.
    const newKey = rotated.fingerprintSaved
      ? []
      : [
          rootApiKeyFingerprint(rotated.apiKey, environment, {
            createdBy: actor,
            createdAt: new Date(),
          }),
        ];
    markCredentialRevoked(rotated.previousApiKey, { ...revocation, replacedBy: rotated.apiKey }, [
      ...newKey,
      rootApiKeyFingerprint(rotated.previousApiKey, environment, {
        createdBy: null,
        createdAt: null,
      }),
    ]);
  }
  for (const revoked of credentials.revokedApiKeys) {
    markCredentialHashRevoked(revoked.keyHash, revocation);
  }
  recordMemberRemovalEvents(credentials, actor);
}

/**
 * The audit events for a member removal's keys: only development environments, which belong to
 * the member. Directory sync removals have no request behind them, so they're attributed to the
 * system.
 */
function recordMemberRemovalEvents(
  credentials: MemberRemovalCredentials,
  actor: AuditLogActor | null
): void {
  const attribution =
    actor?.type === "system" ? { actor: SYSTEM_ACTOR, source: "system" as const } : {};
  const where = (environment: { environmentId: string; projectId: string }) => ({
    organizationId: credentials.organizationId,
    projectId: environment.projectId,
    environmentId: environment.environmentId,
    environmentType: "DEVELOPMENT" as const,
  });
  for (const rotated of credentials.rotatedRootApiKeys) {
    const previousKeyLast4 = rotated.previousApiKey.slice(-4);
    const newKeyLast4 = rotated.apiKey.slice(-4);
    auditLogs.record({
      category: "credentials",
      action: "api_key.rotated",
      ...where(rotated),
      target: { type: "root_api_key", id: rotated.environmentId, name: null },
      keyLast4s: [previousKeyLast4, newKeyLast4],
      changes: { previousKeyLast4, newKeyLast4, graceUntil: null, reason: "member_removed" },
      ...attribution,
    });
  }
  for (const revoked of credentials.revokedApiKeys) {
    auditLogs.record({
      category: "credentials",
      action: "api_key.revoked",
      ...where(revoked),
      target: { type: "additional_api_key", id: revoked.id, name: revoked.name },
      keyLast4s: [revoked.lastFour],
      changes: { reason: "member_removed" },
      ...attribution,
    });
  }
}
