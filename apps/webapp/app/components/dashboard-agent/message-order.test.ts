import { describe, expect, it } from "vitest";
import { createTranscriptOrder, orderTranscript } from "./message-order";

const message = (id: string, parts = 1) => ({
  id,
  parts: Array.from({ length: parts }, () => ({ type: "text" })),
});

describe("orderTranscript", () => {
  it("keeps the stored order and appends live messages after it", () => {
    const base = [message("a"), message("b")];
    const order = createTranscriptOrder(base);

    const result = orderTranscript([...base, message("live-1"), message("live-2")], order);

    expect(result.map((m) => m.id)).toEqual(["a", "b", "live-1", "live-2"]);
  });

  it("puts a replayed stored turn back in its own slot, not after a live message", () => {
    const base = [message("a"), message("b")];
    const order = createTranscriptOrder(base);

    const result = orderTranscript([...base, message("sent"), message("b", 2)], order);

    expect(result.map((m) => m.id)).toEqual(["a", "b", "sent"]);
    expect(result[1]!.parts).toHaveLength(2);
  });

  it("keeps live arrival order stable as later renders add messages", () => {
    const order = createTranscriptOrder([message("a")]);

    orderTranscript([message("a"), message("x")], order);
    const result = orderTranscript([message("a"), message("y"), message("x")], order);

    expect(result.map((m) => m.id)).toEqual(["a", "x", "y"]);
  });

  it("prefers the copy with parts while a duplicate is still empty", () => {
    const order = createTranscriptOrder([]);

    const result = orderTranscript([message("a", 3), message("a", 0)], order);

    expect(result).toHaveLength(1);
    expect(result[0]!.parts).toHaveLength(3);
  });

  it("is a no-op for a transcript with nothing to reorder", () => {
    const messages = [message("a"), message("b"), message("c")];
    const order = createTranscriptOrder(messages);

    expect(orderTranscript(messages, order).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
