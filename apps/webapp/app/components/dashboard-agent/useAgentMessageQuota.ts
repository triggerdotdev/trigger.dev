import { useEffect, useRef, useState } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import {
  quotaResponseUpdate,
  resolveMessageLimit,
  resolveMessageQuota,
  type MessageQuota,
} from "./message-quota";

// Gated on billing PRESENCE, not the plan value: no subscription means billing isn't wired
// up (self-hosted), so there is no cap and no upgrade UI. A wired-up, non-paying plan is free.
function useIsFreePlan(): boolean | undefined {
  const subscription = useCurrentPlan()?.v3Subscription;
  if (!subscription) return undefined;
  return subscription.isPaying === false;
}

// `used` is the server's per-period count for the org. Re-read once a turn settles — the
// server increment happens mid-turn in the `.in` proxy, so reading on optimistic append
// would lag the count by one message and show the cap a message late.
export function useAgentMessageQuota({
  actionPath,
  chatId,
  status,
}: {
  actionPath: string;
  chatId: string;
  status: string;
}): MessageQuota {
  const isFreePlan = useIsFreePlan();
  const [used, setUsed] = useState<number | undefined>(undefined);
  const [serverLimit, setServerLimit] = useState<number | null>(null);

  // Bumped each time the status leaves streaming/submitted, which drives the re-read.
  const [settleTick, setSettleTick] = useState(0);
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasInFlight = prevStatus.current === "streaming" || prevStatus.current === "submitted";
    const nowSettled = status === "ready" || status === "error";
    prevStatus.current = status;
    if (wasInFlight && nowSettled) setSettleTick((tick) => tick + 1);
  }, [status]);

  useEffect(() => {
    if (isFreePlan !== true) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${actionPath}?quota=1`, { signal: controller.signal });
        if (!res.ok) return;
        const update = quotaResponseUpdate(
          (await res.json()) as { used?: number; limit?: number | null }
        );
        if (!update) return;
        setUsed(update.used);
        setServerLimit(update.limit);
      } catch {
        // Leave the count unknown, which means no cap. See `resolveMessageQuota`.
      }
    })();
    return () => controller.abort();
  }, [isFreePlan, actionPath, chatId, settleTick]);

  return resolveMessageQuota({ isFreePlan, used, limit: resolveMessageLimit(serverLimit) });
}
