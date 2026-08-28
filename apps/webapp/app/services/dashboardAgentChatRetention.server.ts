/**
 * The purge behind organization deletion: it soft-deletes the org's chats, and retention
 * hard-deletes them once the window passes.
 */

import { softDeleteChatsForOrganization } from "@internal/dashboard-agent-db";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";

/**
 * Soft-delete every chat belonging to a deleted organization. Retention hard-deletes them
 * once the window passes, so the org-deletion request never runs a cross-database hard delete.
 */
export async function purgeDashboardAgentChatsForOrganization(params: {
  organizationId: string;
}): Promise<number> {
  return softDeleteChatsForOrganization(dashboardAgentDb, params);
}
