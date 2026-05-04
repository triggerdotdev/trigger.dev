import { z } from "zod";
import { logger } from "~/services/logger.server";
import { setExtraConcurrencyQuota } from "~/services/platform.v3.server";
import { CONCURRENCY_QUOTA_INTENT } from "./ConcurrencyQuotaSection";

const RawSchema = z.object({
  intent: z.literal(CONCURRENCY_QUOTA_INTENT),
  // Checkbox arrives as "on" / "true" when checked, absent when not.
  usePlanDefault: z.string().optional(),
  // Empty string when "Use plan default" is checked (the input is disabled).
  extraConcurrencyQuota: z.string().optional(),
});

const SetConcurrencyQuotaSchema = RawSchema.transform((raw, ctx) => {
  const usePlanDefault = !!raw.usePlanDefault;
  if (usePlanDefault) {
    return { extraConcurrencyQuota: null as number | null };
  }
  const trimmed = (raw.extraConcurrencyQuota ?? "").trim();
  if (trimmed.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enter a non-negative integer or check 'Use plan default'.",
      path: ["extraConcurrencyQuota"],
    });
    return z.NEVER;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Quota must be a non-negative integer.",
      path: ["extraConcurrencyQuota"],
    });
    return z.NEVER;
  }
  return { extraConcurrencyQuota: parsed as number | null };
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
      return "Quota must be a non-negative integer (or check 'Use plan default').";
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
