import { describe, it, expect } from "vitest";
import {
  fromFriendlyId,
  generateKsuid,
  isKsuidId,
  RunId,
  toFriendlyId,
} from "./friendlyId.js";

const BASE62 = /^[0-9A-Za-z]+$/;

describe("isKsuidId", () => {
  it("is true for a freshly minted ksuid and its friendlyId", () => {
    const { id, friendlyId } = RunId.generateKsuid();

    expect(isKsuidId(id)).toBe(true);
    expect(isKsuidId(friendlyId)).toBe(true);
  });

  it("is false for a legacy cuid id and its friendlyId", () => {
    const { id, friendlyId } = RunId.generate();

    // sanity: legacy cuid is 25 chars
    expect(id.length).toBe(25);
    expect(isKsuidId(id)).toBe(false);
    expect(isKsuidId(friendlyId)).toBe(false);
  });

  it("is false for empty, prefix-only, and malformed input", () => {
    expect(isKsuidId("")).toBe(false);
    expect(isKsuidId("run_")).toBe(false);

    // 27 chars but contains a non-base62 char (`-`)
    const twentySevenWithDash = `${"a".repeat(26)}-`;
    expect(twentySevenWithDash).toHaveLength(27);
    expect(isKsuidId(twentySevenWithDash)).toBe(false);
    expect(isKsuidId(`run_${twentySevenWithDash}`)).toBe(false);
  });

  it("is false for a 26-char and a 28-char body", () => {
    expect("a".repeat(26)).toHaveLength(26);
    expect(isKsuidId("a".repeat(26))).toBe(false);
    expect(isKsuidId("a".repeat(28))).toBe(false);
    expect(isKsuidId(`run_${"a".repeat(26)}`)).toBe(false);
    expect(isKsuidId(`run_${"a".repeat(28)}`)).toBe(false);
  });
});

describe("generateKsuid", () => {
  it("produces a 27-char base62 body", () => {
    const id = generateKsuid();

    expect(id).toHaveLength(27);
    expect(id).toMatch(BASE62);
  });

  it("produces unique ids across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateKsuid()));

    expect(ids.size).toBe(100);
  });

  it("round-trips through toFriendlyId / fromFriendlyId", () => {
    const id = generateKsuid();
    const friendlyId = toFriendlyId("run", id);

    expect(friendlyId).toBe(`run_${id}`);
    expect(fromFriendlyId(friendlyId)).toBe(id);

    const generated = RunId.generateKsuid();
    expect(generated.friendlyId).toBe(`run_${generated.id}`);
    expect(RunId.fromFriendlyId(generated.friendlyId)).toBe(generated.id);
  });

  it("is time-ordered: a later timestamp sorts after an earlier one", () => {
    // The timestamp lives in the high bytes, so a larger timestamp encodes to a
    // lexicographically-greater (left-padded, fixed-width) base62 string.
    const realNow = Date.now;
    try {
      Date.now = () => 1_500_000_000_000;
      const earlier = generateKsuid();
      Date.now = () => 1_500_000_100_000;
      const later = generateKsuid();

      expect(later > earlier).toBe(true);
      expect(isKsuidId(earlier)).toBe(true);
      expect(isKsuidId(later)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("isKsuidId and the minter agree", () => {
  it("isKsuidId(generateKsuid().id) === true and isKsuidId(generate().id) === false", () => {
    expect(isKsuidId(RunId.generateKsuid().id)).toBe(true);
    expect(isKsuidId(RunId.generate().id)).toBe(false);
  });
});
