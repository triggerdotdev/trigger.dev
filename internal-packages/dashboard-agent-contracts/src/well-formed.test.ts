import { describe, expect, it } from "vitest";
import { sliceWellFormed, toWellFormedDeep } from "./well-formed.js";

const emoji = "😀"; // one surrogate pair

describe("sliceWellFormed", () => {
  it("drops the high surrogate when the cut splits a pair", () => {
    expect(sliceWellFormed(`ab${emoji}`, 3)).toBe("ab");
  });

  it("keeps a pair that fits exactly", () => {
    expect(sliceWellFormed(`ab${emoji}cd`, 4)).toBe(`ab${emoji}`);
  });

  it("leaves ascii alone", () => {
    expect(sliceWellFormed("abcdef", 3)).toBe("abc");
  });

  it("is a no-op when the limit is at or past the length", () => {
    expect(sliceWellFormed(`ab${emoji}`, 4)).toBe(`ab${emoji}`);
    expect(sliceWellFormed(`ab${emoji}`, 99)).toBe(`ab${emoji}`);
  });

  it("keeps a lone surrogate that was already in the input", () => {
    const lone = "ab\ud83d";
    expect(sliceWellFormed(lone, 99)).toBe(lone);
    expect(sliceWellFormed("a\ud83dbc", 3)).toBe("a\ud83db");
  });

  it("drops a pre-existing lone high surrogate that lands on the cut", () => {
    expect(sliceWellFormed("ab\ud83dz", 3)).toBe("ab");
  });

  it("does not alter interior content", () => {
    expect(sliceWellFormed(`${emoji}x${emoji}yz`, 5)).toBe(`${emoji}x${emoji}`);
  });
});

describe("toWellFormedDeep", () => {
  it("replaces a lone surrogate nested in a tool input", () => {
    const message = {
      id: "msg_1",
      role: "assistant",
      parts: [{ type: "tool-search", input: { query: "cat \ud83d", limit: 5 } }],
    };
    const result = toWellFormedDeep(message);
    expect(result.parts[0].input.query).toBe("cat �");
    expect(result.parts[0].input.limit).toBe(5);
    expect(result).not.toBe(message);
  });

  it("returns the same reference when nothing changed", () => {
    const message = { id: "msg_1", parts: [{ text: `hello ${emoji}` }], meta: null };
    expect(toWellFormedDeep(message)).toBe(message);
  });

  it("replaces a lone surrogate in a key", () => {
    const result: Record<string, unknown> = toWellFormedDeep({ "k\ud800": "v" });
    expect(Object.keys(result)).toEqual(["k�"]);
    expect(result["k�"]).toBe("v");
  });

  it("walks arrays", () => {
    const messages = [{ text: "ok" }, { text: "\udc00bad" }];
    const result = toWellFormedDeep(messages);
    expect(result[1].text).toBe("�bad");
    expect(result[0]).toBe(messages[0]);
  });

  it("leaves non-string primitives and non-plain objects alone", () => {
    const date = new Date(0);
    const value = { n: 1, b: true, nil: null, u: undefined, date };
    const result = toWellFormedDeep(value);
    expect(result).toBe(value);
    expect(result.date).toBe(date);
  });
});
