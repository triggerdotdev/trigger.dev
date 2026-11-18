import { tryCatch } from "@trigger.dev/core/utils";
import { useEffect, useState } from "react";
import type { TranscriptSeed } from "~/services/realtime/transcriptSeed.server";

export type ConversationTranscript =
  | { ready: false }
  | {
      ready: true;
      seed: TranscriptSeed | undefined;
      /** A saved transcript couldn't be read, so earlier messages are missing. */
      failed: boolean;
      retry: () => void;
    };

type Fetched = { key: string; seed: TranscriptSeed | undefined; failed?: true };

/**
 * The conversation's saved transcript. The loader reads it when the page opens on the
 * conversation; otherwise it's fetched the first time it's `wanted` and kept for the page.
 * A failed read, from either, settles with no seed (the stream replays instead) and `failed` set.
 * It's tried again on `retry`, or the next time the conversation is shown.
 */
export function useConversationTranscript({
  transcriptPath,
  loaderSeed,
  loaderFailed,
  transcriptRead,
  wanted,
}: {
  transcriptPath: string;
  loaderSeed: TranscriptSeed | undefined;
  loaderFailed: boolean;
  transcriptRead: boolean;
  wanted: boolean;
}): ConversationTranscript {
  const [fetched, setFetched] = useState<Fetched>();
  const [attempt, setAttempt] = useState(0);
  // A failed read, from the fetch or the loader, is tried again the next time it's shown.
  if (!wanted && fetched?.failed) setFetched(undefined);
  if (!wanted && transcriptRead && loaderFailed && attempt === 0) setAttempt(1);

  const fromLoader = transcriptRead && attempt === 0;
  const key = `${transcriptPath}#${attempt}`;
  const needsFetch = !fromLoader && wanted && fetched?.key !== key;

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
        body && !body[0] ? { key, seed: toSeed(body[1]) } : { key, seed: undefined, failed: true }
      );
    })();
    return () => controller.abort();
  }, [needsFetch, transcriptPath, key]);

  const retry = () => setAttempt((n) => n + 1);

  if (fromLoader) return { ready: true, seed: loaderSeed, failed: loaderFailed, retry };
  if (fetched?.key === key) {
    return { ready: true, seed: fetched.seed, failed: fetched.failed === true, retry };
  }
  return { ready: false };
}

function toSeed(body: unknown): TranscriptSeed | undefined {
  if (!body || typeof body !== "object" || !("messages" in body)) return undefined;
  const { messages, nextCursor, lastOutEventId } = body as Partial<TranscriptSeed>;
  if (!Array.isArray(messages)) return undefined;
  return { messages, nextCursor, lastOutEventId };
}
