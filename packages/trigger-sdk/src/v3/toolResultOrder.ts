import type { ModelMessage } from "ai";

type Part = { type?: string; toolCallId?: string };

function callOrderOf(message: ModelMessage): Map<string, number> {
  const order = new Map<string, number>();
  if (!Array.isArray(message.content)) return order;
  for (const part of message.content as Part[]) {
    if (part.type === "tool-call" && typeof part.toolCallId === "string") {
      order.set(part.toolCallId, order.size);
    }
  }
  return order;
}

/**
 * Put each tool message's results in the order of the calls they answer.
 *
 * Within a turn the AI SDK sends parallel tool results in the order the tools
 * finished, while the next turn's history, converted from the stored UI messages,
 * lists them in call order. A model that binds its thinking to the exact history
 * it was produced after (Claude Sonnet 5.5, Opus 5.5, Fable 5.1) then sees the
 * earlier turn change under it, and the thinking that followed no longer
 * validates. Sending call order from the first step keeps both the same.
 *
 * Results only trade places among their own slots; other parts stay put. Returns
 * the same array when nothing moved.
 */
export function withToolResultsInCallOrder(messages: ModelMessage[]): ModelMessage[] {
  let callOrder = new Map<string, number>();
  let changed = false;

  const ordered = messages.map((message) => {
    if (message.role === "assistant") {
      callOrder = callOrderOf(message);
      return message;
    }
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;

    const content = message.content as Part[];
    const slots = content.flatMap((part, index) => (part.type === "tool-result" ? [index] : []));
    if (slots.length < 2) return message;

    const rank = (part: Part) => callOrder.get(part.toolCallId ?? "") ?? Number.MAX_SAFE_INTEGER;
    const results = slots
      .map((slot, index) => ({ part: content[slot]!, index }))
      .sort((a, b) => rank(a.part) - rank(b.part) || a.index - b.index)
      .map(({ part }) => part);
    if (results.every((part, index) => part === content[slots[index]!])) return message;

    const next = [...content];
    slots.forEach((slot, index) => {
      next[slot] = results[index]!;
    });
    changed = true;
    return { ...message, content: next } as ModelMessage;
  });

  return changed ? ordered : messages;
}
