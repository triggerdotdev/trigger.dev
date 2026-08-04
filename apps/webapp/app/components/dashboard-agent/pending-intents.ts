/**
 * The intents the agent emitted as tool results that the host hasn't honoured
 * yet.
 *
 * A tool that emits an intent performs nothing — the panel is what acts, so what
 * the agent then narrates ("you're now on…", "I've filled in a watch") is what
 * actually happened. `seen` is mutated with the calls handled, and is seeded with
 * the transcript loaded at mount, so opening an old chat never re-fires on
 * history: only calls that land while this chat is open are honoured, once each.
 */
import { agentIntentSchema, type AgentIntent } from "@internal/dashboard-agent-contracts";

type ToolPart = { type?: string; state?: string; toolCallId?: string; output?: unknown };
type ToolMessage = { id: string; parts?: ReadonlyArray<unknown> };

function pendingToolIntents<Kind extends AgentIntent["kind"]>(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>,
  toolType: string,
  kind: Kind
): Array<Extract<AgentIntent, { kind: Kind }>> {
  const intents: Array<Extract<AgentIntent, { kind: Kind }>> = [];

  for (const message of messages) {
    const parts = message.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as ToolPart;
      if (part?.type !== toolType || part.state !== "output-available") continue;

      const key = part.toolCallId ?? `${message.id}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const output = part.output as { intent?: unknown } | undefined;
      const parsed = agentIntentSchema.safeParse(output?.intent);
      if (parsed.success && parsed.data.kind === kind) {
        intents.push(parsed.data as Extract<AgentIntent, { kind: Kind }>);
      }
    }
  }

  return intents;
}

/** Where `navigate_to` asked the panel to take the user. */
export function pendingNavigateIntents(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>
): Array<Extract<AgentIntent, { kind: "navigate" }>> {
  return pendingToolIntents(messages, seen, "tool-navigate_to", "navigate");
}

/**
 * The watches `schedule_watch` proposed. The tool never creates one: the spec
 * comes back for the panel to open the configuration card pre-filled, so a
 * free-text ask lands on the same review card as the contextual action.
 */
export function pendingWatchIntents(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>
): Array<Extract<AgentIntent, { kind: "watch" }>> {
  return pendingToolIntents(messages, seen, "tool-schedule_watch", "watch");
}
