import type { ListRunResponse } from "@trigger.dev/core/v3";
import { timeFilters } from "~/components/runs/v3/SharedFilters";

type ApiRunListAppliedCreatedAt = NonNullable<
  NonNullable<ListRunResponse["appliedFilters"]>["createdAt"]
>;

/**
 * The createdAt window the runs list actually queries. With no period, from or to, the list
 * falls back to the default period (7 days) and the API response says so.
 */
export function apiRunListAppliedCreatedAt(input: {
  period?: string;
  from?: number;
  to?: number;
}): ApiRunListAppliedCreatedAt {
  const time = timeFilters({ period: input.period, from: input.from, to: input.to });

  return {
    period: time.period,
    from: time.from,
    to: time.to,
    isDefault: time.isDefault && !input.period,
  };
}
