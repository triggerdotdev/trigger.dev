// `seen` is mutated with the calls handled and must be seeded from the transcript
// loaded at mount, or replaying history re-fires its intents.
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

export function pendingNavigateIntents(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>
): Array<Extract<AgentIntent, { kind: "navigate" }>> {
  return pendingToolIntents(messages, seen, "tool-navigate_to", "navigate");
}

// `schedule_watch` only proposes: the panel creates the watch.
export function pendingWatchIntents(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>
): Array<Extract<AgentIntent, { kind: "watch" }>> {
  return pendingToolIntents(messages, seen, "tool-schedule_watch", "watch");
}
