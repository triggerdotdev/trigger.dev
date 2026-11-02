import { tryCatch } from "@trigger.dev/core/utils";
import { useEffect, useState } from "react";
import type { TranscriptSeed } from "~/services/realtime/transcriptSeed.server";

export type ConversationTranscript =
  | { ready: false }
  | { ready: true; seed: TranscriptSeed | undefined };

type Fetched = { path: string; seed: TranscriptSeed | undefined; failed?: true };

/**
 * The conversation's saved transcript. The loader reads it when the page opens on the
 * conversation; otherwise it's fetched the first time it's `wanted` and kept for the page.
 * A failed fetch settles with no seed, like a session that has none (the stream replays instead),
 * and is tried again the next time the conversation is shown.
 */
export function useConversationTranscript({
  transcriptPath,
  loaderSeed,
  transcriptRead,
  wanted,
}: {
  transcriptPath: string;
  loaderSeed: TranscriptSeed | undefined;
  transcriptRead: boolean;
  wanted: boolean;
}): ConversationTranscript {
  const [fetched, setFetched] = useState<Fetched>();
  if (!wanted && fetched?.failed) setFetched(undefined);
  const needsFetch = !transcriptRead && wanted && fetched?.path !== transcriptPath;

  useEffect(() => {
    if (!needsFetch) return;
    const controller = new AbortController();
    void (async () => {
      const [error, response] = await tryCatch(
        fetch(transcriptPath, { signal: controller.signal })
      );
      if (controller.signal.aborted) return;
      const body = !error && response.ok ? await tryCatch(response.json()) : undefined;
      if (controller.signal.aborted) return;
      setFetched(
        body && !body[0]
          ? { path: transcriptPath, seed: toSeed(body[1]) }
          : { path: transcriptPath, seed: undefined, failed: true }
      );
    })();
    return () => controller.abort();
  }, [needsFetch, transcriptPath]);

  if (transcriptRead) return { ready: true, seed: loaderSeed };
  if (fetched?.path === transcriptPath) return { ready: true, seed: fetched.seed };
  return { ready: false };
}

function toSeed(body: unknown): TranscriptSeed | undefined {
  if (!body || typeof body !== "object" || !("messages" in body)) return undefined;
  const { messages, nextCursor, lastOutEventId } = body as Partial<TranscriptSeed>;
  if (!Array.isArray(messages)) return undefined;
  return { messages, nextCursor, lastOutEventId };
}
