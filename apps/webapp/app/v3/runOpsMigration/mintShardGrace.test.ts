import { describe, expect, it } from "vitest";
import { generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import {
  buildMintShardResolution,
  effectiveMintShardSet,
  isValidPinValue,
  parseShardCsv,
  SHARD_KEY_PATTERN,
  type MintShardSetResolution,
} from "./mintShardGrace";

const GRACE_MS = 90_000;
const T = 1_000_000;

describe("parseShardCsv", () => {
  it("returns an empty list for unset, empty and whitespace input", () => {
    expect(parseShardCsv(undefined)).toEqual([]);
    expect(parseShardCsv("")).toEqual([]);
    expect(parseShardCsv("  ")).toEqual([]);
    expect(parseShardCsv(",,")).toEqual([]);
  });

  it("trims, dedupes and SORTS, so operator typing order cannot change HRW", () => {
    expect(parseShardCsv("b, a ,b")).toEqual(["a", "b"]);
    expect(parseShardCsv("a,b,c")).toEqual(parseShardCsv("c,b,a"));
    expect(parseShardCsv("b,c,a")).toEqual(parseShardCsv("a,c,b"));
  });

  it("accepts every one of the 36 legal shard keys", () => {
    const all = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
    expect(parseShardCsv(all.join(","))).toEqual([...all].sort());
  });

  it("throws on a key outside [a-z0-9]", () => {
    // generateRunOpsIdV2 throws on these; an unvalidated key MUST fail at boot, not at mint.
    expect(() => parseShardCsv("A")).toThrow(/shard key/i);
    expect(() => parseShardCsv("ab")).toThrow(/shard key/i);
    expect(() => parseShardCsv("a,-")).toThrow(/shard key/i);
    expect(() => parseShardCsv("a,_")).toThrow(/shard key/i);
  });

  it("rejects the reserved keys by name", () => {
    expect(() => parseShardCsv("new")).toThrow(/reserved/i);
    expect(() => parseShardCsv("a,legacy")).toThrow(/reserved/i);
  });
});

// Core does not export its shard-char pattern, so pin the local one to the real minter.
describe("shard alphabet agrees with the core minter", () => {
  it("accepts exactly the characters generateRunOpsIdV2 accepts", () => {
    const candidates = [
      ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
      ..."ABZ-_. +/é!".split(""),
      "",
      "ab",
    ];

    for (const candidate of candidates) {
      let minterAccepts = true;
      try {
        generateRunOpsIdV2(candidate);
      } catch {
        minterAccepts = false;
      }

      expect(SHARD_KEY_PATTERN.test(candidate)).toBe(minterAccepts);
    }
  });
});

describe("isValidPinValue", () => {
  it('accepts a shard key, and accepts "new" as the gen-1 hold value', () => {
    expect(isValidPinValue("a")).toBe(true);
    expect(isValidPinValue("7")).toBe(true);
    expect(isValidPinValue("new")).toBe(true);
  });

  it("rejects legacy, and rejects anything outside the alphabet", () => {
    expect(isValidPinValue("legacy")).toBe(false);
    expect(isValidPinValue("A")).toBe(false);
    expect(isValidPinValue("ab")).toBe(false);
    expect(isValidPinValue("")).toBe(false);
  });
});

describe("effectiveMintShardSet", () => {
  it("returns set when there is no stamp", () => {
    const r: MintShardSetResolution = { set: ["a", "b"] };
    expect(effectiveMintShardSet(r, T, GRACE_MS)).toEqual(["a", "b"]);
  });

  it("returns set when flippedAtMs is absent even though prevSet is present", () => {
    const r: MintShardSetResolution = { set: ["a", "b"], prevSet: ["a"] };
    expect(effectiveMintShardSet(r, T, GRACE_MS)).toEqual(["a", "b"]);
  });

  it("serves prevSet inside the window and set at/after the boundary", () => {
    const r: MintShardSetResolution = { set: ["a", "b"], prevSet: ["a"], flippedAtMs: T };
    expect(effectiveMintShardSet(r, T, GRACE_MS)).toEqual(["a"]);
    expect(effectiveMintShardSet(r, T + GRACE_MS - 1, GRACE_MS)).toEqual(["a"]);
    // Boundary is exclusive on the prev side, so every process crosses it together.
    expect(effectiveMintShardSet(r, T + GRACE_MS, GRACE_MS)).toEqual(["a", "b"]);
    expect(effectiveMintShardSet(r, T + GRACE_MS + 1, GRACE_MS)).toEqual(["a", "b"]);
  });

  it("represents a graced first activation as an empty prevSet", () => {
    const r: MintShardSetResolution = { set: ["a"], prevSet: [], flippedAtMs: T };
    expect(effectiveMintShardSet(r, T, GRACE_MS)).toEqual([]);
    expect(effectiveMintShardSet(r, T + GRACE_MS, GRACE_MS)).toEqual(["a"]);
  });

  it("serves a drain through the window", () => {
    const r: MintShardSetResolution = { set: ["a"], prevSet: ["a", "b"], flippedAtMs: T };
    expect(effectiveMintShardSet(r, T + 1, GRACE_MS)).toEqual(["a", "b"]);
    expect(effectiveMintShardSet(r, T + GRACE_MS, GRACE_MS)).toEqual(["a"]);
  });
});

describe("buildMintShardResolution", () => {
  it("omits prevSet entirely when no flip timestamp is configured", () => {
    // A prevSet with no timestamp can never apply, so it MUST NOT linger.
    const r = buildMintShardResolution({ shards: "a,b", prev: "a", flippedAt: undefined });
    expect(r).toEqual({ set: ["a", "b"], prevSet: undefined, flippedAtMs: undefined });
  });

  it("keeps an empty prevSet when a flip timestamp IS configured", () => {
    const r = buildMintShardResolution({
      shards: "a",
      prev: "",
      flippedAt: new Date(T).toISOString(),
    });
    expect(r).toEqual({ set: ["a"], prevSet: [], flippedAtMs: T });
  });

  it("parses the flip timestamp and sorts both lists", () => {
    const r = buildMintShardResolution({
      shards: "b,a",
      prev: "c,a",
      flippedAt: new Date(T).toISOString(),
    });
    expect(r).toEqual({ set: ["a", "b"], prevSet: ["a", "c"], flippedAtMs: T });
  });

  it("treats an unparseable timestamp as no stamp at all", () => {
    const r = buildMintShardResolution({ shards: "a", prev: "b", flippedAt: "not-a-date" });
    expect(r).toEqual({ set: ["a"], prevSet: undefined, flippedAtMs: undefined });
  });
});
