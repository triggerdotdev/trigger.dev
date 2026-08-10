/**
 * Retention for soft-deleted chats. A deleted chat is kept for a grace window and then
 * hard-deleted with all its child rows; one bounded statement per run, oldest first.
 * Also the eventual purge behind organization deletion, which soft-deletes the org's
 * chats so this same sweep removes them.
 */

import {
  hardDeleteChatsSoftDeletedBefore,
  softDeleteChatsForOrganization,
} from "@internal/dashboard-agent-db";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";

/**
 * How long a soft-deleted chat is kept before it and its children are hard-deleted.
 * Long enough that an accidental delete can still be investigated; org deletion soft-
 * deletes the org's chats, so those are removed the same way once the window passes.
 */
export const CHAT_SOFT_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-run cap. Retention is one bounded statement, not a row-at-a-time loop. */
const RETENTION_BATCH_LIMIT = 500;

export type ChatRetentionResult = {
  /** Soft-deleted chats past the retention window dropped this run. */
  purged: number;
  failed: number;
};

export type ChatRetentionDeps = {
  now?: () => Date;
  limit?: number;
  /** Hard-delete chats soft-deleted before `before`. Returns how many went. */
  purge?: (params: { before: Date; limit: number }) => Promise<number>;
};

export async function sweepDashboardAgentSoftDeletedChats(
  deps: ChatRetentionDeps = {}
): Promise<ChatRetentionResult> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? RETENTION_BATCH_LIMIT;
  const purge =
    deps.purge ?? ((params) => hardDeleteChatsSoftDeletedBefore(dashboardAgentDb, params));

  const result: ChatRetentionResult = { purged: 0, failed: 0 };

  try {
    result.purged = await purge({
      before: new Date(now.getTime() - CHAT_SOFT_DELETE_RETENTION_MS),
      limit,
    });
  } catch (error) {
    result.failed++;
    logger.error("Dashboard agent chat retention failed", { error });
  }

  if (result.failed > 0) {
    throw new Error("The dashboard agent chat retention pass failed");
  }

  return result;
}

/**
 * Soft-delete every chat belonging to a deleted organization. The retention sweep above
 * hard-deletes them once the window passes, so the org-deletion request never runs a
 * cross-database hard delete.
 */
export async function purgeDashboardAgentChatsForOrganization(params: {
  organizationId: string;
}): Promise<number> {
  return softDeleteChatsForOrganization(dashboardAgentDb, params);
}
