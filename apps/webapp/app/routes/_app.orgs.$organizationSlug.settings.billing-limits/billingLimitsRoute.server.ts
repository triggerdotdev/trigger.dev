import type {
  BillingLimitResult,
  ResolveBillingLimitRequest,
} from "~/services/billingLimit.schemas";
import { sanitizeRedirectPath } from "~/utils";
import { v3BillingLimitsPath } from "~/utils/pathBuilder";

export function isEnforcementActive(billingLimit: BillingLimitResult): boolean {
  return (
    billingLimit.isConfigured &&
    (billingLimit.limitState.status === "grace" || billingLimit.limitState.status === "rejected")
  );
}

export function getAlertsResetRequested(request: Request): boolean {
  return new URL(request.url).searchParams.get("alertsReset") === "1";
}

export function getEffectiveLimitCentsAfterLimitSave(
  mode: "plan" | "custom" | "none",
  planLimitCents: number,
  customAmountDollars?: number
): number {
  if (mode === "custom") {
    return Math.round((customAmountDollars ?? 0) * 100);
  }

  return planLimitCents;
}

export function getResolveSubmitted(request: Request): boolean {
  return new URL(request.url).searchParams.get("resolved") === "1";
}

export function getSubmittedResumeMode(
  request: Request
): ResolveBillingLimitRequest["resumeMode"] | null {
  const value = new URL(request.url).searchParams.get("resumeMode");
  if (value === "queue" || value === "new_only") {
    return value;
  }
  return null;
}

/**
 * The only prefix a `returnTo` may use. The banner that posts one is rendered by `NavBar`, but it
 * reads the org layout loader's data, so every page able to show it is nested under `/orgs/`.
 */
const RETURN_TO_ALLOWED_PREFIX = "/orgs/";

/**
 * Never a redirect target. `sanitizeRedirectPath` already refuses both, and neither can match the
 * allowed prefix — kept explicit so widening that prefix later cannot silently admit a JSON
 * resource route or the public API.
 */
const RETURN_TO_DENIED_PREFIXES = ["/resources/", "/api/"];

/**
 * Where to send the user after saving the billing limit. Call sites outside the settings page
 * (the org banner) post a `returnTo` so the user stays on the page they were already on.
 *
 * Origin first, then shape. `sanitizeRedirectPath` parses the candidate against a fixed origin and
 * refuses anything whose hostname changes, which is what rules out reverse-solidus authorities like
 * `/\evil.com` that a literal `//` test lets through. Whatever survives must additionally be a
 * dashboard page path; anything else falls back to the settings page.
 */
export function getBillingLimitReturnTo(formData: FormData, organizationSlug: string): string {
  const fallback = v3BillingLimitsPath({ slug: organizationSlug });

  const submitted = formData.get("returnTo");
  const sanitized = sanitizeRedirectPath(
    typeof submitted === "string" ? submitted : null,
    fallback
  );

  if (
    !sanitized.startsWith(RETURN_TO_ALLOWED_PREFIX) ||
    RETURN_TO_DENIED_PREFIXES.some((prefix) => sanitized.startsWith(prefix))
  ) {
    return fallback;
  }

  return sanitized;
}
