/**
 * Caps on one message to the agent, shared by the composer and the two server paths a message
 * can arrive through. Generous for a real question with a pasted stack trace, stingy for a dump:
 * an unbounded paste is a large model bill and a permanently fat transcript.
 */

/** ~2 pages of text, or a long stack trace. */
export const MAX_MESSAGE_CHARS = 8_000;

/** The counter only shows near the limit, so a normal message never sees it. */
export const MESSAGE_CHARS_WARN_AT = Math.floor(MAX_MESSAGE_CHARS * 0.9);

/** The live region rounds the remaining characters up to this, so it speaks in steps. */
export const MESSAGE_ANNOUNCE_STEP = 200;

export const MESSAGE_LIMIT_REACHED_ANNOUNCEMENT = "Message limit reached";

/**
 * What the composer's live region says at this length: empty until the counter is worth
 * showing. The region itself stays mounted whatever this returns — several screen readers only
 * announce changes to a region that was already in the DOM.
 *
 * A live count would be read out once per keystroke, so this steps instead: four announcements
 * between the warning point and the limit, and one more on reaching it. The exact count stays in
 * the visible counter.
 */
export function messageCountAnnouncement(length: number): string {
  if (length < MESSAGE_CHARS_WARN_AT) return "";

  const remaining = Math.max(MAX_MESSAGE_CHARS - length, 0);
  if (remaining === 0) return MESSAGE_LIMIT_REACHED_ANNOUNCEMENT;

  const step = Math.ceil(remaining / MESSAGE_ANNOUNCE_STEP) * MESSAGE_ANNOUNCE_STEP;
  return `${step} characters left`;
}

/** A composed message is a handful of parts; dozens means something is wrong. */
export const MAX_MESSAGE_PARTS = 20;

/**
 * The whole request body, in bytes: headroom for {@link MAX_MESSAGE_CHARS} of any script plus
 * the per-turn metadata, and nothing like a pasted file.
 */
export const MAX_MESSAGE_BODY_BYTES = 64 * 1024;

export const MESSAGE_TOO_LARGE_CODE = "message_too_large";

export const MESSAGE_TOO_LARGE_ERROR = "That message is too long. Shorten it and send again.";

export type MessagePartsProblem = "too_many_parts" | "too_long";

/** Counts the parts and their text. Anything that isn't a parts array is left to the schema. */
export function checkMessageParts(parts: unknown): MessagePartsProblem | null {
  if (!Array.isArray(parts)) return null;
  if (parts.length > MAX_MESSAGE_PARTS) return "too_many_parts";

  let chars = 0;
  for (const part of parts) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === "string") chars += text.length;
  }
  return chars > MAX_MESSAGE_CHARS ? "too_long" : null;
}

/** The declared body size, or null when the client didn't declare one. */
export function declaredBodyBytes(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const bytes = Number.parseInt(raw, 10);
  return Number.isFinite(bytes) ? bytes : null;
}

export function exceedsMessageBodyBytes(bytes: number | null | undefined): boolean {
  return typeof bytes === "number" && bytes > MAX_MESSAGE_BODY_BYTES;
}
