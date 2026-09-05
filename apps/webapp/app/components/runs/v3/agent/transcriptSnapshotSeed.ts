import type { UIMessage } from "@ai-sdk/react";
import { parseTranscriptSnapshot } from "@trigger.dev/core/v3";

export type TranscriptSnapshotSeed = {
  messages: Array<{ id: string; message: UIMessage; timestamp: number }>;
  lastOutEventId: string | undefined;
};

/**
 * Turn a fetched chat-snapshot blob into the messages the AgentView seeds
 * before it opens the `.out` subscription.
 *
 * Each message gets a unique, monotonically increasing timestamp from
 * `(savedAt - count + index)`. Live chunk timestamps are S2 arrival
 * milliseconds in the present, so anything below `savedAt` sorts before
 * live chunks while preserving the snapshot's own order.
 *
 * Reads both snapshot versions through `parseTranscriptSnapshot`. Returns
 * `undefined` for anything that is not a snapshot this reader understands;
 * the caller then falls back to the seq=0 SSE.
 */
export function seedFromTranscriptSnapshot(json: unknown): TranscriptSnapshotSeed | undefined {
  const snapshot = parseTranscriptSnapshot<UIMessage>(json);
  if (!snapshot) return undefined;
  const count = snapshot.messages.length;
  const messages = snapshot.messages.map((entry, i) => ({
    id: entry.id,
    message: entry.message,
    timestamp: snapshot.savedAt - count + i,
  }));
  return { messages, lastOutEventId: snapshot.lastOutEventId };
}
