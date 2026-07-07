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

const LAST_OWNER_NOTIFICATION_TITLE = "Directory Sync: last Owner protected";

// Raise a user-scoped, deduped notification when the directory tried to
// remove the org's last Owner. We keep the member and tell the Owner what to
// do; a single undismissed notification is enough (don't spam on every retry).
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

// Apply one directory-sync membership effect against public.* tables. The
// plugin owns all enterprise.* state and never writes here; this is the only
// path that mutates User / OrgMember / roles / tokens from a directory event.
async function applyEffect(effect: DirectorySyncEffect): Promise<void> {
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

      await ensureOrgMember({
        userId,
        organizationId: effect.organizationId,
        roleId: effect.roleId,
        source: "directory_sync",
      });

      // Directory is authoritative for role: overwrite even for an existing
      // member (ensureOrgMember only sets the role on first create).
      if (effect.roleId) {
        const result = await rbac.setUserRole({
          userId,
          organizationId: effect.organizationId,
          roleId: effect.roleId,
        });
        if (!result.ok) {
          throw new Error(`directorySync provision setUserRole failed: ${result.error}`);
        }
      }
      return;
    }
    case "set_role": {
      const result = await rbac.setUserRole({
        userId: effect.userId,
        organizationId: effect.organizationId,
        roleId: effect.roleId,
      });
      if (!result.ok) {
        throw new Error(`directorySync set_role failed: ${result.error}`);
      }
      return;
    }
    case "deprovision": {
      const outcome = await removeOrgMemberForDirectory({
        userId: effect.userId,
        organizationId: effect.organizationId,
      });
      if (!outcome.removed && outcome.reason === "last_owner_protected") {
        await notifyLastOwnerProtected(effect.userId, effect.organizationId);
      }
      return;
    }
  }
}

// Apply all effects from a processed directory-sync webhook. Effects are
// idempotent, so a worker retry that re-applies them converges. A throw
// propagates to the worker for retry.
export async function applyDirectorySyncEffects(effects: DirectorySyncEffect[]): Promise<void> {
  for (const effect of effects) {
    await applyEffect(effect);
  }
}
