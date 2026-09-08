import { isTrailingAgentRecord } from "@internal/dashboard-agent-contracts";
import { isTurnErrorMessageId } from "./turn-error";

/** Duck-typed, like the transcript readers that use this: only identity and role matter. */
type TranscriptMessage = { role?: string; id?: string };

/**
 * The message a turn is streaming into, or `undefined` when no turn can still be running.
 *
 * Not simply the last message: the agent appends records outside a turn — a watch wake,
 * the investigation one triggers, a settlement card — and they are stored with
 * `role: "assistant"` just like an answer. Walking back over every shape
 * `isTrailingAgentRecord` knows finds the answer underneath them.
 *
 * The walk stops at the turn boundary: a user message, or the stored record of a
 * failure. A dangling part left by an older turn is not this one's, and neither is one
 * on a turn that already ended in an error.
 *
 * Shared, so the hang deadlines and the resume check can never disagree about which
 * message is live.
 */
export function activeTurnMessage<T extends TranscriptMessage>(
  messages: ReadonlyArray<T>
): T | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return undefined;
    if (isTurnErrorMessageId(message?.id)) return undefined;
    if (isTrailingAgentRecord(message?.id)) continue;
    return message;
  }
  return undefined;
}
