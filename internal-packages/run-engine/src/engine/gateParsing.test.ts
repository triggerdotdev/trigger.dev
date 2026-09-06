import { describe, expect, it } from "vitest";
import { parseGates } from "./gateParsing.js";

describe("parseGates", () => {
  it("keeps well-shaped gates and caps at four", () => {
    expect(
      parseGates([
        { queue: "a" },
        { queue: "b", concurrencyKey: "shared" },
        { queue: "c" },
        { queue: "d" },
        { queue: "e" },
      ])
    ).toEqual([
      { queue: "a", concurrencyKey: undefined },
      { queue: "b", concurrencyKey: "shared" },
      { queue: "c", concurrencyKey: undefined },
      { queue: "d", concurrencyKey: undefined },
    ]);
  });

  it("returns empty for non-arrays and empty arrays", () => {
    expect(parseGates(undefined)).toEqual([]);
    expect(parseGates(null)).toEqual([]);
    expect(parseGates("gates")).toEqual([]);
    expect(parseGates([])).toEqual([]);
  });

  it("drops malformed entries", () => {
    expect(parseGates([null, "x", 4, { concurrencyKey: "k" }, { queue: 7 }])).toEqual([]);
  });

  it("drops empty and over-length queue names, keeping exactly 128", () => {
    const max = "q".repeat(128);
    expect(parseGates([{ queue: "" }, { queue: "q".repeat(129) }, { queue: max }])).toEqual([
      { queue: max, concurrencyKey: undefined },
    ]);
  });

  it("treats an empty-string key as omitted and keeps exactly 128-char keys", () => {
    const maxKey = "k".repeat(128);
    expect(parseGates([{ queue: "a", concurrencyKey: "" }])).toEqual([
      { queue: "a", concurrencyKey: undefined },
    ]);
    expect(parseGates([{ queue: "a", concurrencyKey: maxKey }])).toEqual([
      { queue: "a", concurrencyKey: maxKey },
    ]);
  });

  it("drops gates whose literal key exceeds the cap", () => {
    expect(parseGates([{ queue: "a", concurrencyKey: "k".repeat(129) }, { queue: "b" }])).toEqual([
      { queue: "b", concurrencyKey: undefined },
    ]);
  });

  it("ignores non-string keys", () => {
    expect(parseGates([{ queue: "a", concurrencyKey: 5 }])).toEqual([
      { queue: "a", concurrencyKey: undefined },
    ]);
  });
});
