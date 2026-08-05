import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useState } from "react";
import { countUserMessages, resolveMessageQuota, type MessageQuota } from "./message-quota";

// Always undefined until billing supplies plan detection, which means no cap.
function useIsFreePlan(): boolean | undefined {
  return undefined;
}

// Counted in two halves: the server aggregates other chats, this chat's own count
// comes from the live transcript so the message just sent counts immediately.
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
