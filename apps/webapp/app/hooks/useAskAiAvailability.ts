import { useTypedRouteLoaderData } from "remix-typedjson";
import type { AskAiAvailability } from "~/components/dashboard-agent/ask-ai-channels";
import { useFeatures } from "~/hooks/useFeatures";
import { type loader } from "~/root";

/** Both surfaces read the same page-load data, so they always agree on who owns a channel. */
export function useAskAiAvailability(): AskAiAvailability {
  const { isManagedCloud } = useFeatures();
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");

  return { isManagedCloud, kapaWebsiteId: routeMatch?.kapa.websiteId };
}
