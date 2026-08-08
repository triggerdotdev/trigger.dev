/**
 * What the retry button should do after a failed turn.
 *
 * `regenerate()` sends no message at all — the agent trims its trailing assistant and re-runs
 * from its own history. That is only safe once the agent has answered, because a turn can also
 * fail before the message reaches it (a rejected or dropped `.in` append), and on the
 * head-started first turn the agent would then have no history to run on.
 */

export type RetryMessage = {
  id: string;
  role: string;
  parts?: readonly { type: string; text?: string }[];
};

export type RetryAction =
  /** Built-in retry: the agent owns the turn and drops its own partial answer. */
  | { kind: "regenerate" }
  /** Re-send under the same id, so the message lands even if it never did, and never twice. */
  | { kind: "resend"; messageId: string; text: string }
  | null;

export function retryAction(messages: readonly RetryMessage[]): RetryAction {
  const last = messages[messages.length - 1];
  if (!last) return null;
  if (last.role !== "user") return { kind: "regenerate" };

  const text = (last.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();

  return text ? { kind: "resend", messageId: last.id, text } : null;
}
