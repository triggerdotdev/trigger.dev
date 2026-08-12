import type { DirectorySyncEffect } from "@trigger.dev/plugins";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import {
  ensureOrgMember,
  ensureUserForDirectory,
  removeOrgMemberForDirectory,
} from "~/models/orgMember.server";
import { createPlatformNotification } from "~/services/platformNotifications.server";
import { getSsoEntitlement, type SsoEntitlement } from "~/services/platform.v3.server";

const LAST_OWNER_NOTIFICATION_TITLE = "Directory Sync: last Owner protected";

// Effects are idempotent and the worker retries, so a single failed attempt is
// transient (usually a serializable-conflict retry), not an alert. `logLevel`
// makes the worker log it at warn instead of paging.
function retryableEffectError(message: string): Error {
  return Object.assign(new Error(message), { logLevel: "warn" as const });
}

// Deduped notification when the directory tried to remove the org's last Owner:
// we keep the member, and one undismissed notification is enough (no retry spam).
async function notifyLastOwnerProtected(userId: string, organizationId: string): Promise<void> {
  const existing = await prisma.platformNotification.findFirst({
    where: {
      scope: "USER",
      userId,
      surface: "WEBAPP",
      title: LAST_OWNER_NOTIFICATION_TITLE,
      archivedAt: null,
      endsAt: { gt: new Date() },
    },
    select: { id: true, interactions: { where: { userId }, select: { webappDismissedAt: true } } },
  });
  if (existing && !existing.interactions[0]?.webappDismissedAt) {
    return;
  }

  const endsAt = new Date();
  endsAt.setFullYear(endsAt.getFullYear() + 1);

  const result = await createPlatformNotification({
    title: LAST_OWNER_NOTIFICATION_TITLE,
    surface: "WEBAPP",
    scope: "USER",
    userId,
    endsAt: endsAt.toISOString(),
    priority: 10,
    payload: {
      version: "1",
      data: {
        type: "card",
        title: "Directory Sync kept your Owner access",
        description:
          "Your identity provider tried to remove you from this organization, but you are its only Owner. " +
          "We kept your membership to prevent a lockout. Assign another Owner, then the directory change will apply.",
      },
    },
  });
  if (result.isErr()) {
    logger.warn("directorySync: failed to create last-owner notification", {
      userId,
      organizationId,
      error: result.error,
    });
  }
}

/** Applies one effect, returning a user id that still needs provisioning queued. */
async function applyEffect(effect: DirectorySyncEffect): Promise<string | null> {
  switch (effect.kind) {
    case "provision": {
      const userId =
        effect.userId ??
        (
          await ensureUserForDirectory({
            email: effect.email,
            firstName: effect.firstName,
            lastName: effect.lastName,
          })
        ).userId;

      const membership = await ensureOrgMember({
        userId,
        organizationId: effect.organizationId,
        roleId: effect.roleId,
        source: "directory_sync",
      });

      // Directory owns the role: overwrite even an existing member
      // (ensureOrgMember only sets it on create).
      if (effect.roleId) {
        const result = await rbac.setUserRole({
          userId,
          organizationId: effect.organizationId,
          roleId: effect.roleId,
        });
        if (!result.ok) {
          // The org must keep one Owner: skip the role overwrite for the last
          // Owner (they keep Owner) instead of failing the whole batch. Applies
          // to a directory burst and to a dashboard group remap alike.
          if (result.code === "last_owner") {
            logger.info("directorySync: kept last Owner, skipped provision role overwrite", {
              userId,
              organizationId: effect.organizationId,
            });
          } else {
            throw retryableEffectError(
              `directorySync provision setUserRole failed: ${result.error}`
            );
          }
        }
      }

      return membership.devEnvironmentsQueued ? null : userId;
    }
    case "set_role": {
      const result = await rbac.setUserRole({
        userId: effect.userId,
        organizationId: effect.organizationId,
        roleId: effect.roleId,
      });
      if (!result.ok) {
        // Keeping the org's last Owner is expected, not a failure — skip this
        // one member and let the rest of the remap apply (no server error).
        if (result.code === "last_owner") {
          logger.info("directorySync: kept last Owner, skipped set_role", {
            userId: effect.userId,
            organizationId: effect.organizationId,
          });
          return null;
        }
        throw retryableEffectError(`directorySync set_role failed: ${result.error}`);
      }
      return null;
    }
    case "deprovision": {
      const outcome = await removeOrgMemberForDirectory({
        userId: effect.userId,
        organizationId: effect.organizationId,
      });
      if (!outcome.removed && outcome.reason === "last_owner_protected") {
        await notifyLastOwnerProtected(effect.userId, effect.organizationId);
      }
      return null;
    }
  }
}

/** Raised for a batch whose provisioning could not be queued, when the caller can retry. */
export function unqueuedProvisioningError(userIds: string[]): Error {
  return retryableEffectError(
    `directorySync could not queue development environments for users ${userIds.join(", ")}`
  );
}

/**
 * Applies membership effects, skipping any org that isn't entitled to SSO.
 *
 * An unreadable entitlement throws rather than skipping: effects are
 * idempotent and the worker retries, so retrying is lossless where dropping
 * would silently lose a directory change.
 *
 * Reports memberships whose provisioning could not be queued rather than
 * throwing, so a caller with no retry can still finish successfully.
 */
export async function applyDirectorySyncEffects(
  effects: DirectorySyncEffect[]
): Promise<{ unqueuedUserIds: string[] }> {
  const entitlements = new Map<string, SsoEntitlement>();
  const unqueuedUserIds: string[] = [];

  for (const effect of effects) {
    let entitlement = entitlements.get(effect.organizationId);
    if (entitlement === undefined) {
      entitlement = await getSsoEntitlement(effect.organizationId);
      entitlements.set(effect.organizationId, entitlement);
    }

    if (entitlement === "unknown") {
      throw retryableEffectError(
        `directory sync: could not read the SSO entitlement for organization ${effect.organizationId}`
      );
    }

    if (entitlement === "not_entitled") {
      logger.warn("Directory Sync: skipping effect for org without the SSO entitlement", {
        organizationId: effect.organizationId,
        kind: effect.kind,
      });
      continue;
    }

    const unqueuedUserId = await applyEffect(effect);
    if (unqueuedUserId) {
      unqueuedUserIds.push(unqueuedUserId);
    }
  }

  return { unqueuedUserIds };
}
