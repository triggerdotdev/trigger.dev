import type {
  AccessPolicyBanCredentialChanges,
  AuditLogEnvironmentType,
  AuditLogInput,
} from "@trigger.dev/plugins";
import { auditLogs } from "./auditLogs.server";

const ENVIRONMENT_TYPES: ReadonlySet<string> = new Set<AuditLogEnvironmentType>([
  "PRODUCTION",
  "STAGING",
  "DEVELOPMENT",
  "PREVIEW",
]);

function environmentType(type: string): AuditLogEnvironmentType | null {
  return ENVIRONMENT_TYPES.has(type) ? (type as AuditLogEnvironmentType) : null;
}

/**
 * The audit events for what an organization ban rotated and revoked. A ban is a staff action: the
 * customer sees Trigger.dev support, and the staff member stays internal, as for support sessions.
 * Personal access tokens belong to their user, so their events have no organization.
 */
function orgBanAuditEvents(changes: AccessPolicyBanCredentialChanges): AuditLogInput[] {
  const { organizationId } = changes;
  const attribution = {
    actor: { type: "support", id: null },
    source: "staff",
    onBehalfOf: { userId: changes.staffUserId },
  } as const;
  const where = (key: { projectId: string; environmentId: string; environmentType: string }) => ({
    organizationId,
    projectId: key.projectId,
    environmentId: key.environmentId,
    environmentType: environmentType(key.environmentType),
  });

  return [
    ...changes.rotatedRootKeys.map((rotated): AuditLogInput => ({
      category: "credentials",
      action: "api_key.rotated",
      ...where(rotated),
      target: { type: "root_api_key", id: rotated.environmentId, name: null },
      keyLast4s: [rotated.previousKeyLast4, rotated.newKeyLast4],
      changes: {
        previousKeyLast4: rotated.previousKeyLast4,
        newKeyLast4: rotated.newKeyLast4,
        graceUntil: null,
        reason: "banned",
      },
      ...attribution,
    })),
    // An older root key the ban stopped before its grace period ended.
    ...changes.graceEndedRootKeys.map((ended): AuditLogInput => ({
      category: "credentials",
      action: "api_key.revoked",
      ...where(ended),
      target: { type: "root_api_key", id: ended.environmentId, name: null },
      keyLast4s: [ended.keyLast4],
      changes: { reason: "banned" },
      ...attribution,
    })),
    ...changes.revokedApiKeys.map((key): AuditLogInput => ({
      category: "credentials",
      action: "api_key.revoked",
      ...where(key),
      target: { type: "additional_api_key", id: key.id, name: key.name },
      keyLast4s: [key.last4],
      changes: { reason: "banned" },
      ...attribution,
    })),
    ...changes.revokedPersonalAccessTokens.map((token): AuditLogInput => ({
      category: "credentials",
      action: "pat.revoked",
      organizationId: null,
      target: { type: "pat", id: token.id, name: token.name },
      keyLast4s: [token.last4],
      changes: { reason: "banned" },
      ...attribution,
    })),
  ];
}

/** Records a committed ban's audit events, through the usual recording gates. */
export async function recordOrgBanCredentialChanges(
  changes: AccessPolicyBanCredentialChanges
): Promise<void> {
  for (const event of orgBanAuditEvents(changes)) {
    auditLogs.record(event);
  }
}
