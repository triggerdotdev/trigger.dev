// Stored as a JSON string because the flag catalog is scalar-only, so the shape is
// validated at read time in `./promoted`. Set globally or per-org; org wins.
import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { parsePromotedPrompt } from "./promoted";

// Pass `orgFeatureFlags` when the caller already has the org's `featureFlags`
// column, so a per-org chip costs no extra lookup.
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
