import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useState } from "react";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { countUserMessages, resolveMessageQuota, type MessageQuota } from "./message-quota";

/**
 * Whether this org is on the Free plan.
 *
 * Undefined — not false — when we can't tell: self-hosted with no billing
 * service, a billing call that failed, or the org route data not loaded yet. The
 * quota treats undefined as "no cap" (see `resolveMessageQuota`), so an unknown
 * plan can never lock someone out.
 */
function useIsFreePlan(): boolean | undefined {
  const isPaying = useCurrentPlan()?.v3Subscription?.isPaying;
  return typeof isPaying === "boolean" ? !isPaying : undefined;
}

/**
 * The Free-plan message quota for the user, as the open chat sees it.
 *
 * Two halves, because a count that lags the conversation would let the cap be
 * walked past: the server counts the user's messages in every OTHER chat (one
 * aggregate, fetched once per chat — the panel remounts this chat's component on
 * every switch), and this chat's own messages are counted from the live
 * transcript, so the message just sent counts immediately.
 *
 * Nothing is fetched at all unless the org is on the Free plan: a paying org
 * never pays for a query it can't be limited by.
 */
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
  const [usedElsewhere, setUsedElsewhere] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (isFreePlan !== true) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${actionPath}?quota=1&chatId=${encodeURIComponent(chatId)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { used?: number };
        if (typeof data.used === "number") setUsedElsewhere(data.used);
      } catch {
        // Leave the count unknown, which means no cap. See `resolveMessageQuota`.
      }
    })();
    return () => controller.abort();
  }, [isFreePlan, actionPath, chatId]);

  return resolveMessageQuota({
    isFreePlan,
    used: usedElsewhere === undefined ? undefined : usedElsewhere + countUserMessages(messages),
  });
}
