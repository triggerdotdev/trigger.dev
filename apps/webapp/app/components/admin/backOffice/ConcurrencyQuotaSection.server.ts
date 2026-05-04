import { z } from "zod";
import { logger } from "~/services/logger.server";
import { setExtraConcurrencyQuota } from "~/services/platform.v3.server";
import { CONCURRENCY_QUOTA_INTENT } from "./ConcurrencyQuotaSection";

const SetConcurrencyQuotaSchema = z.object({
  intent: z.literal(CONCURRENCY_QUOTA_INTENT),
  // Capped at PostgreSQL INTEGER max for safety; cloud will reject anything
  // unreasonably high on its own (likely with quota_too_high).
  extraConcurrencyQuota: z.coerce.number().int().min(0).max(2_147_483_647),
});

export type ConcurrencyQuotaActionResult =
  | { ok: true }
  | {
      ok: false;
      errors: Record<string, string[] | undefined>;
      formError?: string;
    };

export async function handleConcurrencyQuotaAction(
  formData: FormData,
  orgId: string,
  adminUserId: string
): Promise<ConcurrencyQuotaActionResult> {
  const submission = SetConcurrencyQuotaSchema.safeParse(
    Object.fromEntries(formData)
  );
  if (!submission.success) {
    return { ok: false, errors: submission.error.flatten().fieldErrors };
  }

  const result = await setExtraConcurrencyQuota(orgId, {
    extraConcurrencyQuota: submission.data.extraConcurrencyQuota,
  });

  if (!result) {
    return {
      ok: false,
      errors: {},
      formError:
        "Billing client unavailable — check BILLING_API_URL/BILLING_API_KEY config.",
    };
  }

  if (!result.success) {
    // The platform client's generic error path strips `code` to `error` only
    // until the BillingClient.fetch passthrough fix lands; cast keeps the
    // route forward-compatible so precise UI copy renders automatically once
    // it does.
    const err = result as {
      success: false;
      error: string;
      code?: string;
    };
    return {
      ok: false,
      errors: {},
      formError: mapCodeToMessage(err.code, err.error),
    };
  }

  logger.info("admin.backOffice.concurrencyQuota", {
    adminUserId,
    orgId,
    next: submission.data.extraConcurrencyQuota,
  });

  return { ok: true };
}

function mapCodeToMessage(
  code: string | undefined,
  fallback: string
): string {
  switch (code) {
    case "invalid_body":
      return "Quota must be a non-negative integer.";
    case "quota_too_high":
      // Cloud's `error` string embeds the actual ceiling, prefer it verbatim.
      return fallback || "Cap is too high.";
    case "org_not_found":
      return "Organization not found.";
    case "limits_not_found":
      return "This org has no billing limits row yet.";
    default:
      return fallback || "Failed to update concurrency quota.";
  }
}
