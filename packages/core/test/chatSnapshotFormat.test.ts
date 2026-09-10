import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_TRAILER_BYTES,
  parseTranscriptBlob,
  parseTranscriptEntryLines,
  parseTranscriptFooter,
  planTranscriptPage,
  readTranscriptTrailer,
  serializeTranscriptSnapshot,
  type TranscriptSnapshotV2,
} from "../src/v3/sessionStreams/chatSnapshot.js";
import type { UIMessage } from "ai";

function msg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function snapshot(
  ids: Array<[string, string]>,
  state: unknown = null
): TranscriptSnapshotV2<UIMessage> {
  return {
    version: 2,
    savedAt: 1_700_000_000_000,
    messages: ids.map(([id, text]) => ({ id, final: true, message: msg(id, text) })),
    state,
    lastOutEventId: "42",
    lastInEventId: "7",
  };
}

/** Byte-accurate slice, the way a ranged object-store read behaves. */
function byteSlice(text: string, start: number, end: number): string {
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(bytes.slice(start, end));
}

function footerOf(blob: string) {
  const bytes = new TextEncoder().encode(blob);
  const trailer = readTranscriptTrailer(
    new TextDecoder().decode(bytes.slice(bytes.length - TRANSCRIPT_TRAILER_BYTES))
  );
  expect(trailer).toBeDefined();
  const footerEnd = bytes.length - TRANSCRIPT_TRAILER_BYTES - 1;
  const footerStart = footerEnd - trailer!.footerLength;
  const footer = parseTranscriptFooter(
    new TextDecoder().decode(bytes.slice(footerStart, footerEnd))
  );
  expect(footer).toBeDefined();
  return { footer: footer!, footerStart };
}

describe("transcript blob v2 format", () => {
  it("round-trips a snapshot", () => {
    const original = snapshot(
      [
        ["u-1", "hello"],
        ["a-1", "world"],
      ],
      { v: 1, compaction: { throughId: "u-1", modelMessages: [{ role: "system" }] } }
    );

    const parsed = parseTranscriptBlob(serializeTranscriptSnapshot(original));

    expect(parsed).toBeDefined();
    expect(parsed!.messages.map((e) => e.id)).toEqual(["u-1", "a-1"]);
    expect(parsed!.state).toEqual(original.state);
    expect(parsed!.savedAt).toBe(original.savedAt);
    expect(parsed!.lastOutEventId).toBe("42");
    expect(parsed!.lastInEventId).toBe("7");
  });

  it("round-trips an empty transcript", () => {
    const parsed = parseTranscriptBlob(serializeTranscriptSnapshot(snapshot([])));
    expect(parsed!.messages).toEqual([]);
    expect(parsed!.state).toBeNull();
  });

  it("keeps the private state out of every byte a page read fetches", () => {
    const entries: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [
      `m-${i}`,
      `body ${i}`,
    ]);
    const blob = serializeTranscriptSnapshot(
      snapshot(entries, { v: 1, secret: "PROPRIETARY-LANE" })
    );
    const bytes = new TextEncoder().encode(blob);
    const { footer } = footerOf(blob);
    const plan = planTranscriptPage(footer, { limit: 5 })!;

    // A page read fetches the page window plus the object's tail (footer +
    // trailer). The state lives in the header, so none of that can carry it.
    const fetched = new TextDecoder().decode(bytes.slice(plan!.start));

    expect(blob).toContain("PROPRIETARY-LANE");
    expect(fetched).not.toContain("PROPRIETARY-LANE");
    expect(parseTranscriptEntryLines(byteSlice(blob, plan!.start, plan!.end)).length).toBe(5);
  });

  it("plans a page whose byte window decodes to exactly those entries", () => {
    const entries: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => [
      `m-${i}`,
      `body ${i}`,
    ]);
    const blob = serializeTranscriptSnapshot(snapshot(entries));
    const { footer } = footerOf(blob);

    const plan = planTranscriptPage(footer, { limit: 3 });

    expect(plan).toBeDefined();
    expect(plan!.ids).toEqual(["m-7", "m-8", "m-9"]);
    expect(plan!.nextCursor).toBe("m-7");
    const parsed = parseTranscriptEntryLines(byteSlice(blob, plan!.start, plan!.end));
    expect(parsed.map((e) => e.id)).toEqual(["m-7", "m-8", "m-9"]);
  });

  it("pages backwards through the whole transcript with before", () => {
    const entries: Array<[string, string]> = Array.from({ length: 7 }, (_, i) => [
      `m-${i}`,
      `body ${i}`,
    ]);
    const blob = serializeTranscriptSnapshot(snapshot(entries));
    const { footer } = footerOf(blob);

    const seen: string[][] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const plan = planTranscriptPage(footer, { limit: 3, before });
      if (!plan) break;
      seen.push(
        parseTranscriptEntryLines(byteSlice(blob, plan!.start, plan!.end)).map((e) => e.id)
      );
      if (!plan.nextCursor) break;
      before = plan.nextCursor;
    }

    expect(seen).toEqual([["m-4", "m-5", "m-6"], ["m-1", "m-2", "m-3"], ["m-0"]]);
  });

  it("computes offsets in bytes, not characters", () => {
    // Multibyte content: a character-indexed offset table would slice mid-entry
    // here and decode to garbage.
    const blob = serializeTranscriptSnapshot(
      snapshot([
        ["u-1", "日本語のテキストです"],
        ["a-1", "emoji 🎉🎉🎉 and more"],
        ["u-2", "plain ascii"],
      ])
    );
    const { footer } = footerOf(blob);

    const plan = planTranscriptPage(footer, { limit: 2 });

    const parsed = parseTranscriptEntryLines(byteSlice(blob, plan!.start, plan!.end));
    expect(parsed.map((e) => e.id)).toEqual(["a-1", "u-2"]);
    expect((parsed[0]!.message.parts[0] as { text: string }).text).toBe("emoji 🎉🎉🎉 and more");
  });

  it("carries the stream cursors in the footer, so a page read never needs the header", () => {
    const blob = serializeTranscriptSnapshot(
      snapshot([["u-1", "a"]], { v: 1, secret: "PROPRIETARY-LANE" })
    );
    const { footer } = footerOf(blob);
    expect(footer.lastOutEventId).toBe("42");
    expect(footer.lastInEventId).toBe("7");
  });

  it("the footer's final offset is where the footer line begins", () => {
    const blob = serializeTranscriptSnapshot(
      snapshot([
        ["u-1", "a"],
        ["a-1", "b"],
      ])
    );
    const { footer, footerStart } = footerOf(blob);
    expect(footer.offsets[footer.offsets.length - 1]).toBe(footerStart);
  });

  it("reports each page's position in the whole transcript", () => {
    // Pages are fetched newest first, so a caller ordering them against each
    // other needs positions in the transcript, not in the page.
    const blob = serializeTranscriptSnapshot(
      snapshot(Array.from({ length: 10 }, (_, i) => [`m-${i}`, `body ${i}`]))
    );
    const { footer } = footerOf(blob);

    const newest = planTranscriptPage(footer, { limit: 4 })!;
    expect([newest.startIndex, newest.totalEntries]).toEqual([6, 10]);

    const earlier = planTranscriptPage(footer, { limit: 4, before: newest.nextCursor })!;
    expect([earlier.startIndex, earlier.totalEntries]).toEqual([2, 10]);

    // The two pages do not overlap, and ordering by startIndex reconstructs the
    // conversation.
    expect(earlier.startIndex + earlier.ids.length).toBe(newest.startIndex);
  });

  it("yields an empty page for a cursor the transcript no longer holds", () => {
    // Trimming drops old history, so a client can hold a cursor that is gone.
    // Returning the newest entries would render recent messages as older ones.
    const blob = serializeTranscriptSnapshot(
      snapshot(Array.from({ length: 10 }, (_, i) => [`m-${i}`, `body ${i}`]))
    );
    const { footer } = footerOf(blob);

    expect(planTranscriptPage(footer, { limit: 4, before: "dropped-long-ago" })).toBeUndefined();
  });

  it("returns no plan for an empty page", () => {
    const blob = serializeTranscriptSnapshot(snapshot([]));
    const { footer } = footerOf(blob);
    expect(planTranscriptPage(footer, { limit: 10 })).toBeUndefined();
  });

  it("still reads a version 1 blob written by a released SDK", () => {
    const v1 = JSON.stringify({
      version: 1,
      savedAt: 123,
      messages: [msg("u-1", "hello"), msg("a-1", "world")],
      lastOutEventId: "9",
    });

    const parsed = parseTranscriptBlob(v1);

    expect(parsed!.messages.map((e) => e.id)).toEqual(["u-1", "a-1"]);
    expect(parsed!.messages.every((e) => e.final)).toBe(true);
    expect(parsed!.state).toBeNull();
    expect(parsed!.lastOutEventId).toBe("9");
  });

  it("rejects a trailer that is not one", () => {
    expect(readTranscriptTrailer("nope")).toBeUndefined();
    expect(readTranscriptTrailer("#tt2:notdigits00000\n")).toBeUndefined();
  });

  it("rejects a footer whose offsets do not strictly increase", () => {
    // Corrupt metadata should decline here rather than plan a byte range that
    // drops a message. Equal offsets are a zero-length window, which decodes to
    // no entry while the cursor advances past it.
    expect(parseTranscriptFooter('{"ids":["a","b"],"offsets":[-1,10,20]}')).toBeUndefined();
    expect(parseTranscriptFooter('{"ids":["a","b"],"offsets":[10,5,20]}')).toBeUndefined();
    expect(parseTranscriptFooter('{"ids":["a","b"],"offsets":[0,10,10]}')).toBeUndefined();
    expect(parseTranscriptFooter('{"ids":["a","b"],"offsets":[0,10,20]}')).toBeDefined();
  });

  it("accepts the footer a real serialize produces, whose offsets always increase", () => {
    // Guards the assumption the check above rests on: entries are never
    // zero-length, so a well-formed blob never has equal adjacent offsets.
    const blob = serializeTranscriptSnapshot(
      snapshot(Array.from({ length: 12 }, (_, i) => [`m-${i}`, `body ${i}`]))
    );
    const { footer } = footerOf(blob);

    for (let i = 1; i < footer.offsets.length; i++) {
      expect(footer.offsets[i]!).toBeGreaterThan(footer.offsets[i - 1]!);
    }
  });

  it("rejects a footer whose offsets do not bound its ids", () => {
    expect(parseTranscriptFooter('{"ids":["a","b"],"offsets":[1,2]}')).toBeUndefined();
    expect(parseTranscriptFooter("not json")).toBeUndefined();
  });
});
