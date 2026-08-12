/**
 * Which AI surfaces the reader can actually use. The agent is gated on access, Ask AI exists
 * only where Kapa is configured, and all four combinations ship — so neither surface may assume
 * the other is there, and neither may advertise what the reader cannot reach.
 */
export type AiSurfaces = {
  /** A dashboard-agent host is mounted for this user. */
  agent: boolean;
  /** `askAiCanOpen`: managed cloud with a Kapa website id. */
  askAi: boolean;
};

export type AiMenuEntry = "agent" | "ask-ai";

/** Help & Feedback offers every AI surface the reader has, and nothing when they have none. */
export function aiMenuEntries({ agent, askAi }: AiSurfaces): AiMenuEntry[] {
  const entries: AiMenuEntry[] = [];
  if (agent) entries.push("agent");
  if (askAi) entries.push("ask-ai");
  return entries;
}

export type AiShortcutRow = "agent-toggle" | "ask-ai" | "agent-new-chat" | "agent-close-chat";

/** The shortcuts sheet lists a keystroke only where its surface registered it. */
export function aiShortcutRows({ agent, askAi }: AiSurfaces): AiShortcutRow[] {
  const rows: AiShortcutRow[] = [];
  if (agent) rows.push("agent-toggle");
  if (askAi) rows.push("ask-ai");
  if (agent) rows.push("agent-new-chat", "agent-close-chat");
  return rows;
}
