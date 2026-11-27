import type { PrismaReplicaClient } from "@trigger.dev/database";
import type { CredentialReference } from "./auditLogCredentials.server";

/** When an organization's own key stopped working: revoked or expired. */
type AuditLogKeyEnd = {
  reason: "revoked" | "expired";
  /**
   * When it was revoked, or when it expired. Null for a root key rotated without a grace period:
   * nothing keeps when that happened.
   */
  at: Date | null;
  /** When authentication started rejecting it: after a rotated root key's grace period, or `at`. */
  workedUntil: Date | null;
};

/**
 * What the key's own rows say, next to the key summary: when it last authenticated, which counts
 * every request, not only the audited ones, and how it ended if it no longer works.
 */
export type AuditLogKeyStatus = {
  /** Kept for additional keys and organization access tokens only, to within a few minutes. */
  lastUsedAt: Date | null;
  end: AuditLogKeyEnd | null;
};

/**
 * The picked key's status, scoped to the organization. Null when there is nothing to say: a key
 * picked only by its last 4, an unknown one, and personal access tokens, which belong to their user,
 * so their use would tell the organization about the user's use elsewhere.
 */
export async function auditLogKeyStatus(
  db: PrismaReplicaClient,
  organizationId: string,
  reference: CredentialReference,
  now = new Date()
): Promise<AuditLogKeyStatus | null> {
  switch (reference.kind) {
    case "root": {
      if (!reference.last4) return null;
      // A rotated root key: its value moves to RevokedApiKey, which keeps it working until
      // `expiresAt`. The environment's current key has no row there. Root keys keep no last use.
      const revoked = await db.revokedApiKey.findFirst({
        where: {
          runtimeEnvironmentId: reference.id,
          runtimeEnvironment: { organizationId },
          apiKey: { endsWith: reference.last4 },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, expiresAt: true },
      });
      if (revoked) {
        return {
          lastUsedAt: null,
          end: { reason: "revoked", at: revoked.createdAt, workedUntil: revoked.expiresAt },
        };
      }
      // Rotated without a grace period: no row is kept, but the environment's key has changed.
      const environment = await db.runtimeEnvironment.findFirst({
        where: { id: reference.id, organizationId },
        select: { apiKey: true },
      });
      return environment && !environment.apiKey.endsWith(reference.last4)
        ? { lastUsedAt: null, end: { reason: "revoked", at: null, workedUntil: null } }
        : null;
    }
    case "key": {
      const key = await db.apiKey.findFirst({
        where: { id: reference.id, runtimeEnvironment: { organizationId } },
        select: { revokedAt: true, expiresAt: true, lastUsedAt: true },
      });
      return key ? status(key.lastUsedAt, key, now) : null;
    }
    case "oat": {
      const token = await db.organizationAccessToken.findFirst({
        where: { id: reference.id, organizationId },
        select: { revokedAt: true, expiresAt: true, lastAccessedAt: true },
      });
      return token ? status(token.lastAccessedAt, token, now) : null;
    }
    case "pat":
      return null;
  }
}

function status(
  lastUsedAt: Date | null,
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date
): AuditLogKeyStatus | null {
  // Whichever came first ended it: a key can be revoked after it already expired.
  const expiredAt = key.expiresAt && key.expiresAt <= now ? key.expiresAt : null;
  const end: AuditLogKeyEnd | null =
    expiredAt && (!key.revokedAt || expiredAt <= key.revokedAt)
      ? { reason: "expired", at: expiredAt, workedUntil: expiredAt }
      : key.revokedAt
        ? { reason: "revoked", at: key.revokedAt, workedUntil: key.revokedAt }
        : null;
  return lastUsedAt || end ? { lastUsedAt, end } : null;
}
