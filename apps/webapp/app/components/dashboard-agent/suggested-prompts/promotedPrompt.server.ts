/**
 * The promoted chip slot: one product-controlled suggested prompt, swappable
 * without a deploy.
 *
 * Stored in the `promotedDashboardAgentPrompt` feature flag as a JSON string. The
 * flag catalog is scalar-only, so the structure is validated at read time in
 * `./promoted`. Set globally or per-org; org wins.
 *
 * The value to paste into the flag:
 *   {"id":"sp:promo-blackfriday","label":"Check the queue","prompt":"How is the black-friday queue holding up?"}
 */
import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { parsePromotedPrompt } from "./promoted";

/**
 * The promoted chip for this org, or undefined when none is configured. Pass
 * `orgFeatureFlags` when the caller already has the org's `featureFlags` column,
 * so a per-org chip costs no extra lookup.
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
