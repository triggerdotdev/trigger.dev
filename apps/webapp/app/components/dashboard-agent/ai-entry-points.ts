/**
 * The dashboard agent is gated on access, so it may not advertise itself to a reader who
 * cannot reach it.
 */
export type AiSurfaces = {
  /** A dashboard-agent host is mounted for this user. */
  agent: boolean;
};

export type AiShortcutRow = "agent-toggle" | "agent-new-chat" | "agent-close-chat";

/** The shortcuts sheet lists the agent's keystrokes only where it registered them. */
export function aiShortcutRows({ agent }: AiSurfaces): AiShortcutRow[] {
  return agent ? ["agent-toggle", "agent-new-chat", "agent-close-chat"] : [];
}
