import type { PrismaClientOrTransaction } from "~/db.server";
import { z } from "zod";
import { FirstTouchSchema, type FirstTouch } from "~/utils/firstTouch";
import type { AttioUserSync, AttioWorkspaceSync } from "./attio.server";
import { logger } from "./logger.server";

const ATTIO_API = "https://api.attio.com/v2";

class AttioRequestError extends Error {
  // 5xx/429/408 are transient (the worker retries). Always warn: CRM sync failures never page Sentry.
  readonly transient: boolean;
  readonly logLevel = "warn" as const;

  constructor(
    object: string,
    readonly status: number,
    readonly code: string | undefined,
    body: string
  ) {
    super(`Attio assert ${object} failed with status ${status}: ${body.slice(0, 500)}`);
    this.transient = status >= 500 || status === 429 || status === 408;
  }
}

// Rejections seen in normal operation, e.g. the email already belongs to another Attio user.
const EXPECTED_REJECTION_CODES = new Set(["uniqueness_conflict", "missing_value"]);

// A 4xx can't succeed on retry: warn and finish the job. Others are rethrown so the job retries.
function handleSyncFailure(job: string, ids: Record<string, string>, error: unknown) {
  if (error instanceof AttioRequestError && !error.transient) {
    const expected = error.code !== undefined && EXPECTED_REJECTION_CODES.has(error.code);
    // Never log the body: it can contain the conflicting email.
    logger.warn(
      expected
        ? "Attio sync rejected, not retrying"
        : "Attio sync rejected unexpectedly, not retrying",
      { job, ...ids, status: error.status, code: error.code }
    );
    return;
  }
  throw asWarn(job, error);
}

// Wraps any other failure (network, DB lookup) so the worker logs it at warn; the job still retries.
function asWarn(job: string, error: unknown): Error {
  if (error instanceof AttioRequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`Attio ${job} sync failed: ${message}`, { cause: error }), {
    logLevel: "warn" as const,
  });
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

  async upsertWorkspace(
    payload: AttioWorkspaceSync,
    adminEmail?: string,
    attribution?: SignupAttribution
  ) {
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
      ...attributionValues(attribution),
      is_test: this.options.isTest,
      users: adminRecordId
        ? [{ target_object: "users", target_record_id: adminRecordId }]
        : undefined,
    });
  }

  async upsertUser(payload: AttioUserSync) {
    const values = {
      user_id: payload.userId,
      marketing_opt_in: payload.marketingEmails,
      ...attributionValues(payload),
      signup_date: toDate(payload.createdAt),
      is_test: this.options.isTest,
    };
    try {
      await this.#assert("users", "user_id", { ...values, primary_email_address: payload.email });
    } catch (error) {
      if (!(error instanceof AttioRequestError) || error.code !== "uniqueness_conflict")
        throw error;

      // A concurrent workspace sync may have created this user with the email; update it without.
      try {
        await this.#assert("users", "user_id", values);
      } catch (retryError) {
        // No such user: the email belongs to another Attio user record.
        if (retryError instanceof AttioRequestError && retryError.code === "missing_value")
          throw error;
        throw retryError;
      }
    }
  }
}

// How the user found us and their role, from the onboarding form.
export type SignupAttribution = {
  referralSource?: string | null;
  signupRole?: string | null;
  firstTouch?: FirstTouch | null;
};

// Each field is parsed on its own so one malformed value doesn't drop the rest.
const OnboardingDataSchema = z.object({
  role: z.string().optional().catch(undefined),
  roleOther: z.string().optional().catch(undefined),
  firstTouch: FirstTouchSchema.optional().catch(undefined),
});

export function signupAttributionFromUser(user: {
  referralSource: string | null;
  onboardingData: unknown;
}): SignupAttribution {
  const parsed = OnboardingDataSchema.safeParse(user.onboardingData);
  const data = parsed.success ? parsed.data : {};
  return {
    referralSource: user.referralSource,
    signupRole: data.role === "Other" && data.roleOther ? `Other: ${data.roleOther}` : data.role,
    firstTouch: data.firstTouch,
  };
}

// Attio attribution values; empty ones are left out so they never blank a field.
function attributionValues(attribution: SignupAttribution | undefined) {
  const firstTouch = attribution?.firstTouch;
  return {
    referral_source: attribution?.referralSource || undefined,
    signup_role: attribution?.signupRole || undefined,
    first_touch_utm_source: firstTouch?.utmSource || undefined,
    first_touch_utm_medium: firstTouch?.utmMedium || undefined,
    first_touch_utm_campaign: firstTouch?.utmCampaign || undefined,
    first_touch_referrer: firstTouch?.referrer || undefined,
    first_touch_landing_page: firstTouch?.landingPage || undefined,
  };
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
// The admin's signup attribution goes only on their first org, so later orgs don't repeat it.
export async function syncAttioWorkspace(
  payload: AttioWorkspaceSync,
  client: AttioClient,
  db: PrismaClientOrTransaction
) {
  try {
    const admin = await db.user.findFirst({
      where: { id: payload.adminUserId },
      select: { email: true, referralSource: true, onboardingData: true },
    });

    const attribution =
      admin && !(await createdAnEarlierOrg(db, payload))
        ? signupAttributionFromUser(admin)
        : undefined;
    await client.upsertWorkspace(payload, admin?.email, attribution);
  } catch (error) {
    handleSyncFailure("workspace", { orgId: payload.orgId }, error);
  }
}

export async function syncAttioUser(payload: AttioUserSync, client: AttioClient) {
  try {
    await client.upsertUser(payload);
  } catch (error) {
    handleSyncFailure("user", { userId: payload.userId }, error);
  }
}

// Orgs have no creator column. The creator's membership is written in the same insert as the
// org, so one created within a second of an earlier org marks it as one this user created;
// invited members (and whoever is oldest after the founder leaves) joined later.
const CREATED_WITH_ORG_MS = 1_000;

async function createdAnEarlierOrg(db: PrismaClientOrTransaction, payload: AttioWorkspaceSync) {
  const memberships = await db.orgMember.findMany({
    where: {
      userId: payload.adminUserId,
      organizationId: { not: payload.orgId },
      organization: { createdAt: { lt: payload.createdAt } },
    },
    select: { createdAt: true, organization: { select: { createdAt: true } } },
  });

  return memberships.some(
    (membership) =>
      membership.createdAt.getTime() - membership.organization.createdAt.getTime() <
      CREATED_WITH_ORG_MS
  );
}
