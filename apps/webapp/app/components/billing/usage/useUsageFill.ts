import { tryCatch } from "@trigger.dev/core/utils";
import { useEffect, useState } from "react";
import {
  deserializeRemix,
  type RemixSerializedType,
  type UseDataFunctionReturn,
} from "remix-typedjson";
import type { loader } from "~/routes/resources.orgs.$organizationSlug.billing-usage/route";
import type { BillingUsageResult } from "~/services/billingUsage.server";
import type { MonthlyUsageView, ProjectUsageView } from "~/utils/billingUsageBreakdown";
import {
  pendingUsageDays,
  pendingUsageFetches,
  shouldPollUsage,
  USAGE_PAGE_PARAMS,
} from "~/utils/billingUsagePageState";

type UsageReads = {
  usage: BillingUsageResult<MonthlyUsageView>;
  projectUsage: BillingUsageResult<ProjectUsageView>;
};

type PolledUsage = UseDataFunctionReturn<typeof loader>;

type UsageFill = {
  key: string;
  // Unset until a poll succeeds: the loader's reads are shown until then.
  reads?: UsageReads;
  previousPending: number;
  failed: boolean;
};

/**
 * Shows the loader's reads straight away, then polls the resource route, which stores the next chunk of
 * settled days per call, until none are pending. Everything is keyed by org and month, so a poll for one
 * never shows on another.
 */
export function useUsageFill(organizationSlug: string, month: string, initial: UsageReads) {
  const key = `${organizationSlug}/${month}`;
  const [stored, setStored] = useState<UsageFill>();
  const fill = stored?.key === key ? stored : undefined;
  const reads = fill?.reads ?? initial;
  const pending = pendingUsageFetches(reads.usage, reads.projectUsage);
  // A failed poll keeps the last good reads on screen, and a poll without progress stalls: both stop polling.
  const shouldPoll = !fill?.failed && shouldPollUsage(pending, fill?.previousPending);

  useEffect(() => {
    if (!shouldPoll) return;

    const controller = new AbortController();
    const search = new URLSearchParams({ [USAGE_PAGE_PARAMS.month]: month });
    loadUsageChunk(
      `/resources/orgs/${organizationSlug}/billing-usage?${search}`,
      controller.signal
    ).then((polled) => {
      if (controller.signal.aborted) return;
      setStored((current) => {
        if (polled) return { key, reads: polled, previousPending: pending, failed: false };
        const kept = current?.key === key ? current.reads : undefined;
        return { key, reads: kept, previousPending: pending, failed: true };
      });
    });
    return () => controller.abort();
  }, [key, month, organizationSlug, pending, shouldPoll]);

  return {
    ...reads,
    pendingDays: pendingUsageDays(reads.usage, reads.projectUsage),
    isFilling: shouldPoll,
  };
}

async function loadUsageChunk(url: string, signal: AbortSignal): Promise<UsageReads | undefined> {
  const [requestError, response] = await tryCatch(fetch(url, { signal }));
  if (requestError || !response.ok) return undefined;

  const [parseError, body] = await tryCatch(response.json());
  if (parseError) return undefined;

  const polled = deserializeRemix(body as RemixSerializedType<PolledUsage>);
  if (!polled?.usage.ok || !polled.projectUsage.ok) return undefined;
  return polled;
}
