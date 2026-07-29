/**
 * Which progress line the transcript shows.
 *
 * There are two candidates: a tool's own line ("Running render_view…", rendered
 * under the in-flight tool row) and the turn's generic activity ("Thinking…" /
 * "Working…"). Both were showing at once. The specific line always says more, so
 * it wins and the generic one stands down — exactly one status line at a time.
 */

/** A tool call that hasn't produced output yet, so its row carries a spinner. */
export const IN_FLIGHT_TOOL_STATES = new Set(["input-streaming", "input-available"]);

type ProgressMessage = { role?: string; parts?: ReadonlyArray<unknown> };

/** Whether the last turn already shows a tool's own progress line. */
export function hasToolProgressLine(messages: ReadonlyArray<ProgressMessage>): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;

  return (last.parts ?? []).some((part) => {
    const p = part as { type?: string; state?: string };
    return (
      typeof p?.type === "string" &&
      p.type.startsWith("tool-") &&
      IN_FLIGHT_TOOL_STATES.has(p.state ?? "")
    );
  });
}
