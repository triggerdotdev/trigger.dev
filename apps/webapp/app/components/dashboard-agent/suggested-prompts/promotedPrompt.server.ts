/**
 * The promoted chip slot: one product-controlled suggested prompt, swappable
 * without a deploy.
 *
 * Stored in the `promotedDashboardAgentPrompt` feature flag as a JSON *string*.
 * The flag catalog is deliberately scalar-only (its admin UI renders each flag
 * from `getFlagControlType`, which knows booleans, enums, numbers and strings),
 * so keeping the value a string leaves the catalog and its UI untouched and puts
 * the structure in a schema validated at read time (`./promoted`). Set globally
 * or per-org, org wins — same mechanism as `hasDashboardAgentAccess`.
 *
 * The value to paste into the flag:
 *   {"id":"sp:promo-blackfriday","label":"Check the queue","prompt":"How is the black-friday queue holding up?"}
 */
import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { parsePromotedPrompt } from "./promoted";

/**
 * The promoted chip for this org, or undefined when none is configured.
 * `orgFeatureFlags` is the org's `featureFlags` column when the caller already
 * has it (a layout loader that queried the org with a membership check), so a
 * per-org promoted chip costs no extra lookup.
 */
export async function getPromotedDashboardAgentPrompt(options?: {
  orgFeatureFlags?: Record<string, unknown> | null;
}): Promise<SuggestedPrompt | undefined> {
  const flag = makeFlag();
  const value = await flag({
    key: FEATURE_FLAG.promotedDashboardAgentPrompt,
    overrides: options?.orgFeatureFlags ?? {},
  });

  return parsePromotedPrompt(value);
}
