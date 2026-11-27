import { parseTranscriptBlob } from "@trigger.dev/core/v3";
import type { UIMessage } from "ai";
import { logger } from "~/services/logger.server";
import { chatSnapshotStorageKey } from "~/services/realtime/chatSnapshot.server";
import { readTranscriptPageRanged } from "~/services/realtime/transcriptPage.server";
import { isTranscriptNotFound } from "~/services/realtime/transcriptDownload.server";
import {
  downloadObjectRangeFromObjectStore,
  downloadPacketFromObjectStore,
  getObjectStoreClient,
  parseStorageUri,
} from "~/v3/objectStore.server";
import { ObjectVersionChangedError } from "~/v3/objectStoreClient.server";

/** How many messages the Sessions dashboard seeds before opening the stream. */
export const DASHBOARD_TRANSCRIPT_PAGE = 200;

export type TranscriptSeed = {
  messages: Array<{ id: string; message: UIMessage; timestamp: number }>;
  lastOutEventId: string | undefined;
  nextCursor: string | undefined;
};

/**
 * A seed, nothing saved, or a saved transcript that couldn't be read. `too-large`,
 * `changed` and `unknown-cursor` only come from a read with `bounds`.
 */
export type TranscriptSeedRead =
  | { kind: "seed"; seed: TranscriptSeed }
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "too-large"; bytes: number }
  | { kind: "changed" }
  | { kind: "unknown-cursor" };

/**
 * Caps on the source bytes one read downloads, and the object version every
 * read is pinned to.
 */
export type TranscriptReadBounds = {
  windowBytes: number;
  objectBytes: number;
  ifMatch: string | undefined;
  /** Runs before each GET; throwing stops the read. */
  beforeRead?: () => void;
};

type SessionRef = {
  id: string;
  friendlyId: string;
  chatSnapshotStoragePath: string | null;
};

/**
 * The most recent messages of a session's transcript, for the dashboard to
 * render before it opens the `.out` subscription.
 *
 * Each message gets a unique, monotonically increasing timestamp derived from
 * its position in the WHOLE transcript, not in this page. Pages are fetched
 * newest first, so page-local positions would overlap and the client's sort
 * would interleave an earlier page into a later one. Live chunk timestamps are
 * stream arrival milliseconds in the present, so anything below `savedAt` sorts
 * before live chunks while preserving the transcript's own order.
 *
 * Never throws. A session with no saved transcript is `none`, and the dashboard
 * replays the stream. A saved transcript that can't be read is `failed`, so the
 * dashboard can say the earlier messages are missing.
 */
export async function readSessionTranscriptSeed(input: {
  session: SessionRef;
  projectRef: string;
  envSlug: string;
  limit: number;
  /** Page before this message id, for loading earlier history. */
  before?: string;
  bounds?: TranscriptReadBounds;
}): Promise<TranscriptSeedRead> {
  const { session, projectRef, envSlug, limit, before, bounds } = input;
  const location = { projectRef, envSlug };
  const snapshotKey = chatSnapshotStorageKey(session);

  try {
    // With no store for this key, nothing can have been saved there. A store that can't be set
    // up throws here and counts as a failed read.
    if (!getObjectStoreClient(parseStorageUri(snapshotKey).protocol)) return { kind: "none" };

    const paged = await readTranscriptPageRanged(snapshotKey, location, {
      limit,
      before,
      ...(bounds
        ? {
            maxWindowBytes: bounds.windowBytes,
            ifMatch: bounds.ifMatch,
            beforeRead: bounds.beforeRead,
          }
        : {}),
    });

    if (paged !== "unsupported") {
      if (bounds && paged.unknownCursor) return { kind: "unknown-cursor" };
      return seedRead(
        toSeed(paged.messages, {
          savedAt: paged.savedAt,
          lastOutEventId: paged.cursors.lastOutEventId,
          nextCursor: paged.nextCursor,
          startIndex: paged.startIndex,
          totalEntries: paged.totalEntries,
        })
      );
    }

    // A transcript written by a released SDK, which cannot be read by range.
    const environment = { project: { externalRef: projectRef }, slug: envSlug } as never;
    const whole = bounds
      ? await readBoundedSnapshot(snapshotKey, location, bounds)
      : { kind: "snapshot" as const, snapshot: await readWholeSnapshot(snapshotKey, environment) };
    if (whole.kind === "too-large") return whole;
    const { snapshot } = whole;
    if (!snapshot) return { kind: "none" };

    // A cursor the transcript no longer holds yields nothing rather than the
    // newest page, which would present recent messages as older ones.
    const cursorIndex =
      before === undefined
        ? snapshot.messages.length
        : snapshot.messages.findIndex((entry) => entry.id === before);
    if (cursorIndex === -1) {
      if (bounds) return { kind: "unknown-cursor" };
      return {
        kind: "seed",
        seed: { messages: [], lastOutEventId: snapshot.lastOutEventId, nextCursor: undefined },
      };
    }

    const start = Math.max(0, cursorIndex - limit);
    const tail = snapshot.messages.slice(start, cursorIndex);
    return seedRead(
      toSeed(
        tail.map((entry) => entry.message),
        {
          savedAt: snapshot.savedAt,
          lastOutEventId: snapshot.lastOutEventId,
          nextCursor: start > 0 ? tail[0]?.id : undefined,
          startIndex: start,
          totalEntries: snapshot.messages.length,
        }
      )
    );
  } catch (error) {
    if (isTranscriptNotFound(error)) return { kind: "none" };
    if (bounds && error instanceof ObjectVersionChangedError) return { kind: "changed" };
    bounds?.beforeRead?.();
    logger.warn("SessionPresenter: transcript read failed", {
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed" };
  }
}

function seedRead(seed: TranscriptSeed | undefined): TranscriptSeedRead {
  return seed ? { kind: "seed", seed } : { kind: "none" };
}

/** A whole stored object, in any format this reader understands. */
async function readWholeSnapshot(key: string, environment: never) {
  const packet = await downloadPacketFromObjectStore(
    { dataType: "application/store", data: key },
    environment
  );
  return typeof packet.data === "string" ? parseTranscriptBlob<UIMessage>(packet.data) : undefined;
}

/** The whole object, declined when it is larger than `objectBytes`. */
async function readBoundedSnapshot(
  key: string,
  location: { projectRef: string; envSlug: string },
  bounds: TranscriptReadBounds
) {
  bounds.beforeRead?.();
  const range = await downloadObjectRangeFromObjectStore(
    { dataType: "application/store", data: key },
    location,
    { start: 0, end: bounds.objectBytes },
    bounds.ifMatch ? { ifMatch: bounds.ifMatch } : undefined
  );
  if (range.totalSize > bounds.objectBytes) {
    return { kind: "too-large" as const, bytes: range.totalSize };
  }
  return {
    kind: "snapshot" as const,
    snapshot: parseTranscriptBlob<UIMessage>(new TextDecoder().decode(range.bytes)),
  };
}

function toSeed(
  messages: unknown[],
  meta: {
    savedAt: number | undefined;
    lastOutEventId: string | undefined;
    nextCursor: string | undefined;
    startIndex: number;
    totalEntries: number;
  }
): TranscriptSeed | undefined {
  const base = meta.savedAt ?? 0;
  const seeded: TranscriptSeed["messages"] = [];

  messages.forEach((message, index) => {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0) return;
    const ordinal = meta.startIndex + index;
    seeded.push({
      id,
      message: message as UIMessage,
      timestamp: base - meta.totalEntries + ordinal,
    });
  });

  if (seeded.length === 0 && meta.lastOutEventId === undefined) return undefined;
  return { messages: seeded, lastOutEventId: meta.lastOutEventId, nextCursor: meta.nextCursor };
}
