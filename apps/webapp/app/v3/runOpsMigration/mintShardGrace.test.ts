import { describe, expect, it } from "vitest";
import { generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import {
  effectiveMintShardSet,
  isValidPinValue,
  parseShardCsv,
  readMintShardSetResolution,
  SHARD_KEY_PATTERN,
  stampMintShardSetFlip,
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

describe("readMintShardSetResolution", () => {
  it("returns an empty set for an absent record", () => {
    expect(readMintShardSetResolution(undefined)).toEqual({ set: [] });
    expect(readMintShardSetResolution({})).toEqual({ set: [] });
  });

  it("reads and sorts the trio", () => {
    const r = readMintShardSetResolution({
      runOpsMintShardSet: "b,a",
      runOpsMintShardSetPrev: "c,a",
      runOpsMintShardSetFlippedAt: new Date(T).toISOString(),
    });
    expect(r).toEqual({ set: ["a", "b"], prevSet: ["a", "c"], flippedAtMs: T });
  });

  it("omits prevSet when no flip timestamp is stored", () => {
    // A prevSet with no timestamp can never apply, so it MUST NOT linger.
    const r = readMintShardSetResolution({
      runOpsMintShardSet: "a,b",
      runOpsMintShardSetPrev: "a",
    });
    expect(r).toEqual({ set: ["a", "b"], prevSet: undefined, flippedAtMs: undefined });
  });

  it("keeps an empty prevSet when a timestamp IS stored, which graces a first activation", () => {
    const r = readMintShardSetResolution({
      runOpsMintShardSet: "a",
      runOpsMintShardSetPrev: "",
      runOpsMintShardSetFlippedAt: new Date(T).toISOString(),
    });
    expect(r).toEqual({ set: ["a"], prevSet: [], flippedAtMs: T });
  });

  it("degrades a stored value it cannot parse to an empty list instead of throwing", () => {
    // Boot may throw on a bad env var. The mint path must never throw on a bad stored value.
    expect(() => readMintShardSetResolution({ runOpsMintShardSet: "NOPE" })).not.toThrow();
    expect(readMintShardSetResolution({ runOpsMintShardSet: "NOPE" }).set).toEqual([]);
    expect(readMintShardSetResolution({ runOpsMintShardSet: 42 }).set).toEqual([]);
    expect(
      readMintShardSetResolution({
        runOpsMintShardSet: "a",
        runOpsMintShardSetFlippedAt: "not-a-date",
      })
    ).toEqual({ set: ["a"], prevSet: undefined, flippedAtMs: undefined });
  });
});

describe("stampMintShardSetFlip", () => {
  it("does nothing when the save omits the set", () => {
    // Omitting the set is an unrelated flag change; it must not inject a default or reset the clock.
    const outgoing = { someOtherFlag: true } as Record<string, unknown>;
    expect(stampMintShardSetFlip({ runOpsMintShardSet: "a" }, outgoing, T, GRACE_MS)).toEqual({
      someOtherFlag: true,
    });
  });

  it("stamps prev and flippedAt on a genuine change", () => {
    const stamped = stampMintShardSetFlip(
      { runOpsMintShardSet: "a" },
      { runOpsMintShardSet: "a,b" },
      T,
      GRACE_MS
    );
    expect(stamped.runOpsMintShardSetPrev).toBe("a");
    expect(stamped.runOpsMintShardSetFlippedAt).toBe(new Date(T).toISOString());
  });

  it("stamps an empty prev on a first activation", () => {
    const stamped = stampMintShardSetFlip({}, { runOpsMintShardSet: "a" }, T, GRACE_MS);
    expect(stamped.runOpsMintShardSetPrev).toBe("");
    expect(stamped.runOpsMintShardSetFlippedAt).toBe(new Date(T).toISOString());
  });

  it("treats a reordered list as no change", () => {
    const stamped = stampMintShardSetFlip(
      { runOpsMintShardSet: "a,b" },
      { runOpsMintShardSet: "b,a" },
      T,
      GRACE_MS
    );
    expect(stamped.runOpsMintShardSetFlippedAt).toBeUndefined();
  });

  it("carries an in-flight stamp forward rather than resetting the cutover clock", () => {
    const existing = {
      runOpsMintShardSet: "a,b",
      runOpsMintShardSetPrev: "a",
      runOpsMintShardSetFlippedAt: new Date(T).toISOString(),
    };
    const stamped = stampMintShardSetFlip(
      existing,
      { runOpsMintShardSet: "a,b" },
      T + 1000,
      GRACE_MS
    );
    expect(stamped.runOpsMintShardSetPrev).toBe("a");
    expect(stamped.runOpsMintShardSetFlippedAt).toBe(new Date(T).toISOString());
  });

  it("stamps prev as the CURRENTLY-EFFECTIVE set when a second flip lands mid-window", () => {
    // Two flips inside one window must not strand the original prev; prev is what readers serve now.
    const existing = {
      runOpsMintShardSet: "a,b",
      runOpsMintShardSetPrev: "a",
      runOpsMintShardSetFlippedAt: new Date(T).toISOString(),
    };
    const stamped = stampMintShardSetFlip(
      existing,
      { runOpsMintShardSet: "a,b,c" },
      T + 1000,
      GRACE_MS
    );
    expect(stamped.runOpsMintShardSetPrev).toBe("a");
  });
});
