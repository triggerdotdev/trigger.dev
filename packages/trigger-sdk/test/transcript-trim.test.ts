import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  normalizeRuntimeStateForWindow,
  restoreModelLane,
  trimTranscriptForSnapshot,
  type TranscriptRuntimeState,
} from "../src/v3/transcriptStorage.js";

function entry(id: string) {
  return { id, final: true, message: { id, role: "user", parts: [] } as unknown as UIMessage };
}

const entries = (n: number, prefix = "m") =>
  Array.from({ length: n }, (_, i) => entry(`${prefix}-${i}`));

const compacted = (throughId: string): TranscriptRuntimeState => ({
  v: 1,
  compaction: {
    throughId,
    modelMessages: [{ role: "assistant", content: "[summary of the dropped span]" }],
  },
});

const convert = async (messages: UIMessage[]) =>
  messages.map((m) => ({ role: "user", content: m.id }) as never);

describe("trimTranscriptForSnapshot", () => {
  it("keeps everything after the watermark plus the requested scrollback", () => {
    const kept = trimTranscriptForSnapshot(entries(300), compacted("m-199"), { keep: 100 });

    // 100 before the watermark (m-100..m-199) and everything after it.
    expect(kept).toHaveLength(200);
    expect(kept[0]!.id).toBe("m-100");
    expect(kept[kept.length - 1]!.id).toBe("m-299");
  });

  it("keeps the watermark entry itself, so a restored lane can still find it", () => {
    const kept = trimTranscriptForSnapshot(entries(300), compacted("m-199"), { keep: 1 });

    expect(kept[0]!.id).toBe("m-199");
  });

  it("keeps the last N when the watermark is the newest message", () => {
    // What the runtime actually produces: it stamps the watermark at the newest
    // message on each compacted save, so the retained window is the tail.
    const kept = trimTranscriptForSnapshot(entries(300), compacted("m-299"), { keep: 100 });

    expect(kept).toHaveLength(100);
    expect(kept[0]!.id).toBe("m-200");
    expect(kept[kept.length - 1]!.id).toBe("m-299");
  });

  it("keeps everything when the conversation has not compacted", () => {
    const all = entries(500);
    expect(trimTranscriptForSnapshot(all, null, { keep: 100 })).toBe(all);
    expect(trimTranscriptForSnapshot(all, { v: 1 }, { keep: 100 })).toBe(all);
  });

  it("keeps everything for a watermark this transcript does not hold", () => {
    const all = entries(300);
    expect(trimTranscriptForSnapshot(all, compacted("not-here"), { keep: 100 })).toBe(all);
    expect(trimTranscriptForSnapshot(all, compacted(""), { keep: 100 })).toBe(all);
  });

  it("keeps everything when the scrollback already reaches the start", () => {
    const all = entries(50);
    expect(trimTranscriptForSnapshot(all, compacted("m-9"), { keep: 100 })).toBe(all);
  });
});

describe("a trimmed transcript still restores the model's context", () => {
  it("restores the summary plus the retained window", async () => {
    const kept = trimTranscriptForSnapshot(entries(300), compacted("m-199"), { keep: 100 });
    const persisted = normalizeRuntimeStateForWindow(
      compacted("m-199"),
      kept.map((e) => e.id)
    ) as TranscriptRuntimeState;

    const restored = await restoreModelLane(
      kept.map((e) => e.message),
      persisted,
      convert
    );

    // The watermark survives the trim, so the lane is the summary followed by
    // the entries after it, not a re-conversion of the whole window.
    expect(restored.compacted).toBe(true);
    expect(restored.messages[0]).toEqual({
      role: "assistant",
      content: "[summary of the dropped span]",
    });
    expect(restored.messages).toHaveLength(101);
    expect(restored.messages.at(-1)).toEqual({ role: "user", content: "m-299" });
  });

  it("still restores when the watermark falls outside the retained window", async () => {
    // Guards the reason `normalizeRuntimeStateForWindow` exists: a watermark the
    // window no longer holds would otherwise discard the summary and rebuild
    // context from a fragment, which reads as an agent that has forgotten.
    const window = entries(40, "w");
    const persisted = normalizeRuntimeStateForWindow(
      compacted("gone"),
      window.map((e) => e.id)
    ) as TranscriptRuntimeState;

    const restored = await restoreModelLane(
      window.map((e) => e.message),
      persisted,
      convert
    );

    expect(restored.compacted).toBe(true);
    expect(restored.messages[0]).toEqual({
      role: "assistant",
      content: "[summary of the dropped span]",
    });
  });
});
