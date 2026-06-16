import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "./logger.server";

// Syncs new orgs/users into Attio (workspaces/users objects) at signup, via the
// common worker so a slow Attio never blocks signup. Ongoing field updates are
// handled by the scheduled sync, not here. No-op without ATTIO_API_KEY.

const ATTIO_API = "https://api.attio.com/v2";
const IS_TEST = env.APP_ENV !== "production";

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

class AttioClient {
  constructor(private readonly apiKey: string) {}

  // Create-or-update by unique attribute; returns the record id. Throws on failure so the worker retries.
  async #assert(object: string, matchingAttribute: string, values: Record<string, unknown>): Promise<string> {
    const url = `${ATTIO_API}/objects/${object}/records?matching_attribute=${matchingAttribute}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { values } }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error("Attio assert failed", { object, matchingAttribute, status: response.status, body });
      throw new Error(`Attio assert ${object} failed with status ${response.status}`);
    }

    return ((await response.json()) as any).data?.id?.record_id as string;
  }

  async upsertWorkspace(payload: AttioWorkspaceSync, emailDomain?: string) {
    // The creating user is an admin of the new org — set their role and link them to the workspace.
    const adminRecordId = await this.#assert("users", "user_id", {
      user_id: payload.adminUserId,
      role: "Admin",
      is_test: IS_TEST,
    });

    await this.#assert("workspaces", "workspace_id", {
      workspace_id: payload.orgId,
      name: payload.title,
      org_slug: payload.slug,
      company_size: payload.companySize ?? undefined,
      email_domain: emailDomain,
      signup_date: toDate(payload.createdAt),
      plan: "Free",
      account_status: "Active",
      is_test: IS_TEST,
      users: [{ target_object: "users", target_record_id: adminRecordId }],
    });
  }

  async upsertUser(payload: AttioUserSync) {
    await this.#assert("users", "user_id", {
      user_id: payload.userId,
      primary_email_address: payload.email,
      marketing_opt_in: payload.marketingEmails,
      referral_source: payload.referralSource ?? undefined,
      signup_date: toDate(payload.createdAt),
      is_test: IS_TEST,
    });
  }
}

// Attio `date` attributes want a bare YYYY-MM-DD value.
function toDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Domain from an email; the cloud-side matcher normalizes it further.
function domainFromEmail(email: string | undefined): string | undefined {
  return email?.split("@")[1]?.toLowerCase().trim() || undefined;
}

export const attioClient = env.ATTIO_API_KEY ? new AttioClient(env.ATTIO_API_KEY) : null;

export async function enqueueAttioWorkspaceSync(payload: AttioWorkspaceSync) {
  if (!attioClient) return;
  try {
    // Lazy import to avoid a circular dependency with commonWorker (which imports this module's schemas).
    const { commonWorker } = await import("~/v3/commonWorker.server");
    await commonWorker.enqueue({ id: `attio:workspace:${payload.orgId}`, job: "attio.syncWorkspace", payload });
  } catch (error) {
    logger.error("Failed to enqueue Attio workspace sync", { orgId: payload.orgId, error });
  }
}

export async function enqueueAttioUserSync(payload: AttioUserSync) {
  if (!attioClient) return;
  try {
    const { commonWorker } = await import("~/v3/commonWorker.server");
    await commonWorker.enqueue({ id: `attio:user:${payload.userId}`, job: "attio.syncUser", payload });
  } catch (error) {
    logger.error("Failed to enqueue Attio user sync", { userId: payload.userId, error });
  }
}

export async function runAttioWorkspaceSync(payload: AttioWorkspaceSync) {
  if (!attioClient) return;
  const admin = await prisma.user.findUnique({
    where: { id: payload.adminUserId },
    select: { email: true },
  });
  await attioClient.upsertWorkspace(payload, domainFromEmail(admin?.email));
}

export async function runAttioUserSync(payload: AttioUserSync) {
  if (!attioClient) return;
  await attioClient.upsertUser(payload);
}
