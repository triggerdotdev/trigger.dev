import {
  parseTranscriptEntryLines,
  parseTranscriptFooter,
  planTranscriptPage,
  readTranscriptTrailer,
  TRANSCRIPT_BLOB_CONTENT_TYPE,
  TRANSCRIPT_TRAILER_BYTES,
  type TranscriptFooter,
  type TranscriptPagePlan,
} from "@trigger.dev/core/v3";
import { downloadObjectRangeFromObjectStore } from "~/v3/objectStore.server";
import { ObjectVersionChangedError } from "~/v3/objectStoreClient.server";

/**
 * How many bytes to read from the end of the object on the first request. Sized
 * to cover the trailer, the entry index and a default-sized page together, so
 * the common read costs one ranged GET.
 */
const SUFFIX_READ_BYTES = 1_024 * 1_024;

/** Entries a caller will not be paged past in one request, whatever it asks. */
const MAX_PAGE_ENTRIES = 1_000;

export type TranscriptPage = {
  messages: unknown[];
  nextCursor: string | undefined;
  savedAt: number | undefined;
  /** Position of the page's first message in the whole transcript. */
  startIndex: number;
  /** Messages in the whole transcript. */
  totalEntries: number;
  cursors: { lastOutEventId?: string; lastInEventId?: string };
  /** An entry larger than `maxWindowBytes`, skipped without being downloaded. */
  omitted?: { index: number; bytes: number; id: string };
  /** Set when `before` names no entry in the transcript. */
  unknownCursor?: true;
};

/** Where a session's transcript object lives in the object store. */
export type TranscriptStoreLocation = { projectRef: string; envSlug: string };

type Suffix = {
  bytes: Uint8Array;
  totalSize: number;
  contentType: string | undefined;
  etag: string | undefined;
};

/**
 * Read one page of a transcript without parsing the whole object.
 *
 * Reads the end of the object, takes the entry index from its footer and
 * decodes only the byte window holding the requested entries, so the cost is
 * proportional to the page rather than to the conversation.
 *
 * Returns `"unsupported"` when the object is not in the line-based format — a
 * version 1 blob from a released SDK, or a partial write — and the caller falls
 * back to reading and parsing the whole object. Also when the object is
 * rewritten mid-read: a page stitched from several ranges would otherwise apply
 * one version's offsets to another version's bytes, so every follow-up range
 * carries the first read's version and a mismatch declines rather than
 * returning entries that do not belong together.
 *
 * With `ifMatch`, every read is pinned to that version and a change throws
 * `ObjectVersionChangedError` instead. With `maxWindowBytes`, a footer or page
 * window larger than it is not downloaded. `beforeRead` runs before each GET
 * and may throw to stop the read.
 */
export async function readTranscriptPageRanged(
  storageKey: string,
  location: TranscriptStoreLocation,
  opts:
    | {
        limit?: number;
        before?: string;
        maxWindowBytes?: number;
        ifMatch?: string;
        beforeRead?: () => void;
      }
    | undefined
): Promise<TranscriptPage | "unsupported"> {
  opts?.beforeRead?.();
  const suffix = await readSuffix(storageKey, location, opts?.ifMatch);
  if (!suffix) return "unsupported";

  let footer: TranscriptFooter | undefined;
  try {
    footer = await resolveFooter(
      storageKey,
      location,
      suffix,
      opts?.maxWindowBytes,
      opts?.beforeRead
    );
  } catch (error) {
    if (error instanceof ObjectVersionChangedError && !opts?.ifMatch) return "unsupported";
    throw error;
  }
  if (!footer) return "unsupported";

  const cursors = {
    lastOutEventId: footer.lastOutEventId,
    lastInEventId: footer.lastInEventId,
  };
  const limit = Math.min(opts?.limit ?? MAX_PAGE_ENTRIES, MAX_PAGE_ENTRIES);
  const planned = planTranscriptPage(footer, { limit, before: opts?.before });
  const fitted =
    planned && opts?.maxWindowBytes !== undefined
      ? fitTranscriptPageToBytes(footer, planned, opts.maxWindowBytes)
      : undefined;
  const plan = fitted?.plan ?? planned;

  if (!plan) {
    return {
      messages: [],
      nextCursor: undefined,
      savedAt: footer.savedAt,
      startIndex: 0,
      totalEntries: footer.ids.length,
      cursors,
      ...(opts?.before !== undefined && !footer.ids.includes(opts.before)
        ? { unknownCursor: true as const }
        : {}),
    };
  }

  if (fitted?.omitted) {
    return {
      messages: [],
      nextCursor: plan.nextCursor,
      savedAt: footer.savedAt,
      startIndex: plan.startIndex,
      totalEntries: plan.totalEntries,
      cursors,
      omitted: fitted.omitted,
    };
  }

  let window: Uint8Array;
  try {
    window = await readWindow(storageKey, location, suffix, plan.start, plan.end, opts?.beforeRead);
  } catch (error) {
    if (error instanceof ObjectVersionChangedError && !opts?.ifMatch) return "unsupported";
    throw error;
  }
  const entries = parseTranscriptEntryLines(new TextDecoder().decode(window));

  return {
    messages: entries.map((entry) => entry.message),
    nextCursor: plan.nextCursor,
    savedAt: footer.savedAt,
    startIndex: plan.startIndex,
    totalEntries: plan.totalEntries,
    cursors,
  };
}

/**
 * Shrink a page to the newest whole entries whose bytes fit `maxWindowBytes`,
 * the source bytes the page may download. When the newest entry alone is
 * larger, the page holds nothing and reports it omitted, with the cursor past it.
 */
function fitTranscriptPageToBytes(
  footer: TranscriptFooter,
  plan: TranscriptPagePlan,
  maxWindowBytes: number
): { plan: TranscriptPagePlan; omitted?: { index: number; bytes: number; id: string } } {
  const endIndex = plan.startIndex + plan.ids.length;
  let first = endIndex;
  while (first > plan.startIndex && plan.end - footer.offsets[first - 1]! <= maxWindowBytes) {
    first--;
  }
  if (first === plan.startIndex) return { plan };

  if (first === endIndex) {
    const index = endIndex - 1;
    const start = footer.offsets[index]!;
    return {
      plan: {
        ...plan,
        start,
        end: start,
        ids: [],
        nextCursor: index > 0 ? footer.ids[index] : undefined,
        startIndex: index,
      },
      omitted: { index, bytes: plan.end - start, id: footer.ids[index]! },
    };
  }

  return {
    plan: {
      ...plan,
      start: footer.offsets[first]!,
      ids: footer.ids.slice(first, endIndex),
      nextCursor: footer.ids[first],
      startIndex: first,
    },
  };
}

async function readSuffix(
  key: string,
  location: TranscriptStoreLocation,
  ifMatch: string | undefined
): Promise<Suffix | undefined> {
  const range = await downloadObjectRangeFromObjectStore(
    { dataType: "application/store", data: key },
    location,
    { suffixLength: SUFFIX_READ_BYTES },
    ifMatch ? { ifMatch } : undefined
  );

  if (
    range.contentType !== undefined &&
    !range.contentType.startsWith(TRANSCRIPT_BLOB_CONTENT_TYPE)
  ) {
    return undefined;
  }
  if (range.bytes.byteLength < TRANSCRIPT_TRAILER_BYTES) return undefined;

  return range;
}

/**
 * The footer, from the already-fetched suffix when it fits, otherwise from a
 * second ranged read. A footer larger than the suffix window only happens on a
 * conversation with very many entries.
 */
async function resolveFooter(
  key: string,
  location: TranscriptStoreLocation,
  suffix: Suffix,
  maxFooterBytes: number | undefined,
  beforeRead: (() => void) | undefined
): Promise<TranscriptFooter | undefined> {
  const decoder = new TextDecoder();
  const trailer = readTranscriptTrailer(
    decoder.decode(suffix.bytes.subarray(suffix.bytes.byteLength - TRANSCRIPT_TRAILER_BYTES))
  );
  if (!trailer) return undefined;
  if (maxFooterBytes !== undefined && trailer.footerLength > maxFooterBytes) return undefined;

  const footerEndFromEnd = TRANSCRIPT_TRAILER_BYTES + 1;

  if (trailer.footerLength + footerEndFromEnd <= suffix.bytes.byteLength) {
    const end = suffix.bytes.byteLength - footerEndFromEnd;
    return parseTranscriptFooter(
      decoder.decode(suffix.bytes.subarray(end - trailer.footerLength, end))
    );
  }

  const end = suffix.totalSize - footerEndFromEnd;
  const start = end - trailer.footerLength;
  if (start < 0) return undefined;

  beforeRead?.();
  const range = await downloadObjectRangeFromObjectStore(
    { dataType: "application/store", data: key },
    location,
    { start, end },
    { ifMatch: suffix.etag }
  );
  return parseTranscriptFooter(decoder.decode(range.bytes));
}

/** The page's bytes, from the fetched suffix when it covers them. */
async function readWindow(
  key: string,
  location: TranscriptStoreLocation,
  suffix: Suffix,
  start: number,
  end: number,
  beforeRead: (() => void) | undefined
): Promise<Uint8Array> {
  const suffixStart = suffix.totalSize - suffix.bytes.byteLength;
  if (start >= suffixStart) {
    return suffix.bytes.subarray(start - suffixStart, end - suffixStart);
  }
  beforeRead?.();
  const range = await downloadObjectRangeFromObjectStore(
    { dataType: "application/store", data: key },
    location,
    { start, end },
    { ifMatch: suffix.etag }
  );
  return range.bytes;
}
