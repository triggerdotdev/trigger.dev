/**
 * Which message parts carry prose the user should read.
 *
 * Besides `text`, that is a `reasoning` part with text in it. The agent asks for
 * `display: "updates"`, so the only reasoning text it gets back is a note the model
 * wrote for the user ahead of a tool call: Sonnet 5.5 returns those as thinking blocks
 * rather than text, often with the turn's actual answer in them. Thinking itself comes
 * back with its text omitted.
 */

type PartLike = { type?: string; text?: string };

function isProseType(type: string | undefined): boolean {
  return type === "text" || type === "reasoning";
}

/** A text or reasoning part with something in it. */
export function isProsePart(part: PartLike | undefined): boolean {
  return isProseType(part?.type) && (part?.text ?? "").trim().length > 0;
}

/** A text or reasoning part still streaming in, whether or not any of it has arrived. */
export function isStreamingProsePart(part: (PartLike & { state?: string }) | undefined): boolean {
  return isProseType(part?.type) && part?.state === "streaming";
}
