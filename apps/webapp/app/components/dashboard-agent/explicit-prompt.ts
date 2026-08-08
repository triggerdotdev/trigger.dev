/** What to do with a prompt the user asked for by clicking, rather than by typing. */
export type ExplicitPromptTarget = "new-chat" | "send-to-open-chat" | "hold";

/**
 * A click on Investigate or a prompt chip always ends in a sent message; only where it lands
 * depends on the panel. `hold` is not a refusal — the request stays pending and is asked again
 * once the chat has opened or its turn has finished.
 */
export function explicitPromptTarget(panel: {
  chat: "none" | "opening" | "open";
  turnInFlight: boolean;
}): ExplicitPromptTarget {
  if (panel.chat === "opening") return "hold";
  if (panel.chat === "none") return "new-chat";
  return panel.turnInFlight ? "hold" : "send-to-open-chat";
}
