import {
  hasUnfinishedTextPart,
  IN_FLIGHT_TOOL_STATES,
  inFlightToolName,
  liveInvestigation,
} from "./progress-line";

/**
 * Re-reading the stored transcript once a turn settles.
 *
 * The turn's terminal records — a force-settled investigation card, a failure
 * record — are written to the chat row, not pushed as a stream chunk. An open panel
 * has already closed its stream by then, so without this it keeps rendering the last
 * `in_progress` revision and spins until the user reloads.
 */

type Identified = { id: string };

/** A message whose stream died mid-tool or mid-text: a part still reads as running. */
function stillRunning(message: unknown): boolean {
  const parts = (message as { parts?: ReadonlyArray<{ type?: string; state?: string }> })?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      (typeof part?.type === "string" &&
        part.type.startsWith("tool-") &&
        IN_FLIGHT_TOOL_STATES.has(part.state ?? "")) ||
      (part?.type === "text" && part.state === "streaming")
  );
}

/**
 * Merge the authoritative re-read into what the panel holds, keyed on the message id.
 *
 * Genuinely-new messages (a settlement card is `investigation-settlement:{id}:{revision}`)
 * are appended, so re-reading the same transcript any number of times never produces a
 * second copy. A message whose in-memory copy died mid-tool — a stream that EOF'd before
 * the part settled — is replaced by its finished version from the re-read; otherwise it
 * would show that step running forever. We only replace a still-running copy with a copy
 * that has itself settled, so a live turn streaming under the same id is left alone and
 * ordering is preserved.
 */
export function mergeSettledMessages<T extends Identified>(current: T[], fetched: T[]): T[] {
  const byId = new Map(fetched.map((message) => [message.id, message]));

  let replaced = false;
  const next = current.map((existing) => {
    const settled = byId.get(existing.id);
    if (settled && settled !== existing && stillRunning(existing) && !stillRunning(settled)) {
      replaced = true;
      return settled;
    }
    return existing;
  });

  const missing = fetched.filter(
    (message) => !current.some((existing) => existing.id === message.id)
  );
  if (missing.length === 0) return replaced ? next : current;
  return [...next, ...missing];
}

/** Whether the transcript still resolves to a card mid-investigation. */
export function hasOpenInvestigation(messages: ReadonlyArray<unknown>): boolean {
  return liveInvestigation(messages as never) !== null;
}

/**
 * Whether the transcript still reads as mid-turn. A stream that dies without
 * `turn-complete` leaves the tool part it was on dangling forever, so an open card is
 * not the only shape a re-read has to recover from.
 */
export function transcriptLooksUnfinished(messages: ReadonlyArray<unknown>): boolean {
  return (
    hasOpenInvestigation(messages) ||
    inFlightToolName(messages as never) !== null ||
    hasUnfinishedTextPart(messages as never)
  );
}

/**
 * The settlement is written in `onTurnComplete`, which runs AFTER the client's stream
 * closes, so the first re-read can legitimately land before it. Retry a few times,
 * then leave it: a reload and the between-turns sweep are both still backstops.
 */
const SETTLE_REFETCH_DELAYS_MS = [200, 800, 2_500];

export async function pollSettledTranscript<T extends Identified>(deps: {
  fetchTranscript: () => Promise<T[] | null>;
  apply: (merge: (current: T[]) => T[]) => void;
  wait: (ms: number) => Promise<void>;
  delays?: ReadonlyArray<number>;
}): Promise<void> {
  for (const delay of deps.delays ?? SETTLE_REFETCH_DELAYS_MS) {
    await deps.wait(delay);
    const fetched = await deps.fetchTranscript();
    if (!fetched) return;
    deps.apply((current) => mergeSettledMessages(current, fetched));
    // The stored transcript is the authority on whether anything is still open. Same test that
    // starts the poll, so a stream that died mid-tool is followed until it settles too.
    if (!transcriptLooksUnfinished(fetched)) return;
  }
}

export async function fetchChatTranscript<T extends Identified>(
  actionPath: string,
  chatId: string
): Promise<T[] | null> {
  try {
    const res = await fetch(`${actionPath}?chatId=${encodeURIComponent(chatId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(data.messages)) return null;
    // Anything else under `messages` is not a transcript; keep only what merging can key on.
    return data.messages.filter(
      (message): message is T =>
        typeof message === "object" &&
        message !== null &&
        typeof (message as Identified).id === "string"
    );
  } catch (error) {
    console.error("Dashboard agent: failed to re-read the settled transcript", error);
    return null;
  }
}
