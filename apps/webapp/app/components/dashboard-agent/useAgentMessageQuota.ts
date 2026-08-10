import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useState } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { countUserMessages, resolveMessageQuota, type MessageQuota } from "./message-quota";

// Gated on billing PRESENCE, not the plan value: no subscription means billing isn't wired
// up (self-hosted), so there is no cap and no upgrade UI. A wired-up, non-paying plan is free.
function useIsFreePlan(): boolean | undefined {
  const subscription = useCurrentPlan()?.v3Subscription;
  if (!subscription) return undefined;
  return subscription.isPaying === false;
}

// `used` is the server's per-period count for the org. Re-read whenever the user sends, so
// the running total tracks the message just sent without counting the transcript twice.
export function useAgentMessageQuota({
  actionPath,
  chatId,
  messages,
}: {
  actionPath: string;
  chatId: string;
  messages: UIMessage[];
}): MessageQuota {
  const isFreePlan = useIsFreePlan();
  const [used, setUsed] = useState<number | undefined>(undefined);
  const sentCount = countUserMessages(messages);

  useEffect(() => {
    if (isFreePlan !== true) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${actionPath}?quota=1`, { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { used?: number };
        if (typeof data.used === "number") setUsed(data.used);
      } catch {
        // Leave the count unknown, which means no cap. See `resolveMessageQuota`.
      }
    })();
    return () => controller.abort();
  }, [isFreePlan, actionPath, chatId, sentCount]);

  return resolveMessageQuota({ isFreePlan, used });
}
