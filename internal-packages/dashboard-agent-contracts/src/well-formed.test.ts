import { describe, expect, it } from "vitest";
import { sliceWellFormed } from "./well-formed.js";

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
