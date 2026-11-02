import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { AttioClient, syncAttioWorkspace } from "./attioClient.server";
import { logger } from "./logger.server";

// Syncs new orgs/users into Attio (workspaces/users objects) at signup, via the
// common worker so a slow Attio never blocks signup. Ongoing field updates are
// handled by the scheduled sync, not here. No-op without ATTIO_API_KEY.

export const AttioWorkspaceSyncSchema = z.object({
  orgId: z.string(),
  title: z.string(),
  slug: z.string(),
  companySize: z.string().nullish(),
  createdAt: z.coerce.date(),
  adminUserId: z.string(),
});
export type AttioWorkspaceSync = z.infer<typeof AttioWorkspaceSyncSchema>;

export const AttioUserSyncSchema = z.object({
  userId: z.string(),
  email: z.string(),
  referralSource: z.string().nullish(),
  marketingEmails: z.boolean(),
  createdAt: z.coerce.date(),
});
export type AttioUserSync = z.infer<typeof AttioUserSyncSchema>;

const attioClient = env.ATTIO_API_KEY
  ? new AttioClient({ apiKey: env.ATTIO_API_KEY, isTest: env.APP_ENV !== "production" })
  : null;

export async function enqueueAttioWorkspaceSync(payload: AttioWorkspaceSync) {
  if (!attioClient) return;
  try {
    // Lazy import to avoid a circular dependency with commonWorker (which imports this module's schemas).
    const { commonWorker } = await import("~/v3/commonWorker.server");
    await commonWorker.enqueue({
      id: `attio:workspace:${payload.orgId}`,
      job: "attio.syncWorkspace",
      payload,
    });
  } catch (error) {
    logger.error("Failed to enqueue Attio workspace sync", { orgId: payload.orgId, error });
  }
}

export async function enqueueAttioUserSync(payload: AttioUserSync) {
  if (!attioClient) return;
  try {
    const { commonWorker } = await import("~/v3/commonWorker.server");
    await commonWorker.enqueue({
      id: `attio:user:${payload.userId}`,
      job: "attio.syncUser",
      payload,
    });
  } catch (error) {
    logger.error("Failed to enqueue Attio user sync", { userId: payload.userId, error });
  }
}

export async function runAttioWorkspaceSync(payload: AttioWorkspaceSync) {
  if (!attioClient) return;
  await syncAttioWorkspace(payload, attioClient, prisma);
}

export async function runAttioUserSync(payload: AttioUserSync) {
  if (!attioClient) return;
  await attioClient.upsertUser(payload);
}
