/**
 * Two entry points belong to Ask AI (`components/AskAI.tsx`): ⌘I, and the CLI's `?aiHelp=`
 * link. The dashboard agent is reached by explicit invocation only — no deep links — except as
 * the fall-through here: Ask AI is Kapa, which only exists on managed cloud, so both channels
 * go to the agent wherever Kapa cannot open.
 */

import type { Shortcut } from "~/hooks/useShortcutKeys";

/** Registered by whichever surface owns the channel — never both. */
export const ASK_AI_SHORTCUT: Shortcut = {
  modifiers: ["mod"],
  key: "i",
  enabledOnInputElements: true,
};

export type AskAiAvailability = {
  isManagedCloud: boolean;
  kapaWebsiteId: string | undefined;
};

export function askAiCanOpen(availability: AskAiAvailability): boolean {
  return availability.isManagedCloud && !!availability.kapaWebsiteId;
}

export type AskAiChannelTarget = "ask-ai" | "dashboard-agent";

export function askAiChannelTarget(availability: AskAiAvailability): AskAiChannelTarget {
  return askAiCanOpen(availability) ? "ask-ai" : "dashboard-agent";
}

/** The CLI's link. Ask AI's own deep-link reader is keyed to this name. */
export const ASK_AI_DEEP_LINK_PARAM = "aiHelp";

export type DeepLinkParam = typeof ASK_AI_DEEP_LINK_PARAM;

// Returned by identity, so the reader's effect doesn't re-run every render.
const NO_PARAMS: readonly DeepLinkParam[] = [];
const ASK_AI_PARAMS: readonly DeepLinkParam[] = [ASK_AI_DEEP_LINK_PARAM];

/**
 * The agent owns no deep link of its own. It reads `aiHelp` only as the fall-through: both
 * surfaces watch the URL and whichever reads the param first deletes it, so where Ask AI can
 * open, the agent must not look at all.
 */
export function agentDeepLinkParams(availability: AskAiAvailability): readonly DeepLinkParam[] {
  return askAiChannelTarget(availability) === "ask-ai" ? NO_PARAMS : ASK_AI_PARAMS;
}

/** Where `trigger dev`'s "Get a fix for this error using AI" link lands. */
export function aiHelpRedirectUrl({
  environmentPath,
  origin,
  query,
}: {
  environmentPath: string;
  origin: string;
  query: string;
}): string {
  const url = new URL(environmentPath, origin);
  url.searchParams.set(ASK_AI_DEEP_LINK_PARAM, query);
  return url.toString();
}
