import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FirstTouchSchema } from "~/utils/firstTouch";
import { AttioClient, syncAttioUser, syncAttioWorkspace } from "./attioClient.server";
import { syncAttioMember, syncAttioWorkspaceMembers } from "./attioMembers.server";
import { logger } from "./logger.server";

// Syncs new orgs/users into Attio (workspaces/users objects) at signup and again when
// the onboarding form is submitted, via the common worker so a slow Attio never blocks
// signup. Ongoing field updates are handled by the scheduled sync, not here. No-op
// without ATTIO_API_KEY.

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
  // From the onboarding form; absent on the sync enqueued at account creation.
  signupRole: z.string().nullish(),
  firstTouch: FirstTouchSchema.nullish(),
  marketingEmails: z.boolean(),
  createdAt: z.coerce.date(),
});
export type AttioUserSync = z.infer<typeof AttioUserSyncSchema>;

export const AttioMemberSyncSchema = z.object({ organizationId: z.string(), userId: z.string() });
export const AttioWorkspaceMembersSyncSchema = z.object({ organizationId: z.string() });

const memberSyncEnabled =
  env.ATTIO_MEMBER_SYNC_ENABLED === "1" ||
  (env.APP_ENV === "production" && env.ATTIO_MEMBER_SYNC_ENABLED !== "0");

const attioClient = env.ATTIO_API_KEY
  ? new AttioClient({
      apiKey: env.ATTIO_API_KEY,
      isTest: env.APP_ENV !== "production",
      memberSyncEnabled,
    })
  : null;

// Lets a burst of changes (e.g. join then leave) land before the job reads the membership.
const MEMBER_SYNC_DELAY_MS = 10_000;

// Queues a sync of the user's membership in the org and of the org's member list. Call it after
// the change commits; the jobs read the current state, so a join, role change or leave all fit.
export async function enqueueAttioMemberSync(params: { organizationId: string; userId: string }) {
  if (!attioClient || !memberSyncEnabled) return;
  const { organizationId, userId } = params;
  try {
    const { commonWorker } = await import("~/v3/commonWorker.server");
    const availableAt = new Date(Date.now() + MEMBER_SYNC_DELAY_MS);
    await commonWorker.enqueue({
      id: `attio:member:${organizationId}:${userId}`,
      job: "attio.syncMember",
      payload: { organizationId, userId },
      availableAt,
    });
    await commonWorker.enqueue({
      id: `attio:workspaceMembers:${organizationId}`,
      job: "attio.syncWorkspaceMembers",
      payload: { organizationId },
      availableAt,
    });
  } catch (error) {
    logger.warn("Failed to enqueue Attio member sync", { organizationId, userId, error });
  }
}

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
    logger.warn("Failed to enqueue Attio workspace sync", { orgId: payload.orgId, error });
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
    logger.warn("Failed to enqueue Attio user sync", { userId: payload.userId, error });
  }
}

export async function runAttioWorkspaceSync(payload: AttioWorkspaceSync) {
  if (!attioClient) return;
  await syncAttioWorkspace(payload, attioClient, prisma);
}

export async function runAttioUserSync(payload: AttioUserSync) {
  if (!attioClient) return;
  await syncAttioUser(payload, attioClient);
}

export async function runAttioMemberSync(payload: z.infer<typeof AttioMemberSyncSchema>) {
  if (!attioClient || !memberSyncEnabled) return;
  // Lazy import: rbac.server pulls in much of the app, which imports this module.
  const { rbac } = await import("./rbac.server");
  await syncAttioMember(payload, attioClient, prisma, (params) => rbac.getUserRole(params));
}

export async function runAttioWorkspaceMembersSync(
  payload: z.infer<typeof AttioWorkspaceMembersSyncSchema>
) {
  if (!attioClient || !memberSyncEnabled) return;
  await syncAttioWorkspaceMembers(payload, attioClient, prisma);
}
