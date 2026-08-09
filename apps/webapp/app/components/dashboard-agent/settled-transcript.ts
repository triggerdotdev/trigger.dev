import { inFlightToolName, liveInvestigation } from "./progress-line";

/**
 * Re-reading the stored transcript once a turn settles.
 *
 * The turn's terminal records — a force-settled investigation card, a failure
 * record — are written to the chat row, not pushed as a stream chunk. An open panel
 * has already closed its stream by then, so without this it keeps rendering the last
 * `in_progress` revision and spins until the user reloads.
 */

type Identified = { id: string };

/**
 * Append-only, keyed on the message id. Ids are stable (a settlement card is
 * `investigation-settlement:{id}:{revision}`), so re-reading the same transcript any
 * number of times can never produce a second copy of a card, and nothing already
 * rendered is reordered or replaced.
 */
export function mergeSettledMessages<T extends Identified>(current: T[], fetched: T[]): T[] {
  const missing = fetched.filter(
    (message) => !current.some((existing) => existing.id === message.id)
  );
  return missing.length === 0 ? current : [...current, ...missing];
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
  return hasOpenInvestigation(messages) || inFlightToolName(messages as never) !== null;
}

/**
 * The settlement is written in `onTurnComplete`, which runs AFTER the client's stream
 * closes, so the first re-read can legitimately land before it. Retry a few times,
 * then leave it: a reload and the between-turns sweep are both still backstops.
 */
export const SETTLE_REFETCH_DELAYS_MS = [200, 800, 2_500];

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
    // The stored transcript is the authority on whether anything is still open.
    if (!hasOpenInvestigation(fetched)) return;
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
