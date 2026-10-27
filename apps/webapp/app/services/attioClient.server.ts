import type { PrismaClientOrTransaction } from "~/db.server";
import type { AttioUserSync, AttioWorkspaceSync } from "./attio.server";
import { logger } from "./logger.server";

const ATTIO_API = "https://api.attio.com/v2";

class AttioRequestError extends Error {
  // 5xx/429 are transient (the worker retries); tagged warn so they don't page Sentry.
  readonly transient: boolean;
  readonly logLevel?: "warn";

  constructor(
    object: string,
    readonly status: number,
    readonly code: string | undefined,
    body: string
  ) {
    super(`Attio assert ${object} failed with status ${status}: ${body.slice(0, 500)}`);
    this.transient = status >= 500 || status === 429;
    if (this.transient) this.logLevel = "warn";
  }
}

export type AttioClientOptions = {
  apiKey: string;
  // Marks records written from non-production environments.
  isTest: boolean;
  baseUrl?: string;
};

export class AttioClient {
  constructor(private readonly options: AttioClientOptions) {}

  // Create-or-update by unique attribute; returns the record id. Throws on failure so the worker retries.
  async #assert(
    object: string,
    matchingAttribute: string,
    values: Record<string, unknown>
  ): Promise<string> {
    const baseUrl = this.options.baseUrl ?? ATTIO_API;
    const url = `${baseUrl}/objects/${object}/records?matching_attribute=${matchingAttribute}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { values } }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AttioRequestError(object, response.status, errorCode(body), body);
    }

    const recordId = ((await response.json()) as any).data?.id?.record_id;
    if (typeof recordId !== "string") {
      throw new Error(`Attio assert ${object}: response missing data.id.record_id`);
    }
    return recordId;
  }

  // The org's creator as an Attio admin user. Returns undefined when Attio rejects the user,
  // so the workspace is still written; transient failures throw so the job retries.
  async #assertAdminUser(userId: string, email: string | undefined) {
    const values = { user_id: userId, role: "Admin", is_test: this.options.isTest };
    try {
      return await this.#assert("users", "user_id", values);
    } catch (error) {
      if (!(error instanceof AttioRequestError) || error.transient) throw error;
      let rejection = error;

      // No Attio user yet, and creating one requires the email.
      if (rejection.code === "missing_value" && email) {
        try {
          return await this.#assert("users", "user_id", {
            ...values,
            primary_email_address: email,
          });
        } catch (createError) {
          if (!(createError instanceof AttioRequestError) || createError.transient) {
            throw createError;
          }
          rejection = createError;
        }

        // A concurrent user sync may have created the user meanwhile.
        if (rejection.code === "uniqueness_conflict") {
          try {
            return await this.#assert("users", "user_id", values);
          } catch (retryError) {
            if (!(retryError instanceof AttioRequestError) || retryError.transient) {
              throw retryError;
            }
          }
        }
      }

      logger.warn("Attio admin user not synced, writing the workspace without it", {
        userId,
        error: rejection.message,
      });
      return undefined;
    }
  }

  async upsertWorkspace(payload: AttioWorkspaceSync, adminEmail?: string) {
    const adminRecordId = await this.#assertAdminUser(payload.adminUserId, adminEmail);

    await this.#assert("workspaces", "workspace_id", {
      workspace_id: payload.orgId,
      name: payload.title,
      org_slug: payload.slug,
      company_size: payload.companySize ?? undefined,
      email_domain: domainFromEmail(adminEmail),
      signup_date: toDate(payload.createdAt),
      plan: "Free",
      account_status: "Active",
      is_test: this.options.isTest,
      users: adminRecordId
        ? [{ target_object: "users", target_record_id: adminRecordId }]
        : undefined,
    });
  }

  async upsertUser(payload: AttioUserSync) {
    await this.#assert("users", "user_id", {
      user_id: payload.userId,
      primary_email_address: payload.email,
      marketing_opt_in: payload.marketingEmails,
      referral_source: payload.referralSource ?? undefined,
      signup_date: toDate(payload.createdAt),
      is_test: this.options.isTest,
    });
  }
}

// Attio `date` attributes want a bare YYYY-MM-DD value.
function toDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Attio error bodies look like {"code":"missing_value",...}.
function errorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// Domain from an email; the cloud-side matcher normalizes it further.
function domainFromEmail(email: string | undefined): string | undefined {
  return email?.split("@")[1]?.toLowerCase().trim() || undefined;
}

// Writes the org's workspace, looking up its admin's email for the user record and domain.
export async function syncAttioWorkspace(
  payload: AttioWorkspaceSync,
  client: AttioClient,
  db: PrismaClientOrTransaction
) {
  const admin = await db.user.findFirst({
    where: { id: payload.adminUserId },
    select: { email: true },
  });
  await client.upsertWorkspace(payload, admin?.email);
}
