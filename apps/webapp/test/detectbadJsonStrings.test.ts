import { describe, expect, it } from "vitest";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";

describe("detectBadJsonStrings", () => {
  it("should not detect valid JSON string", () => {
    const goodJson = `{"title": "hello"}`;
    const result = detectBadJsonStrings(goodJson);
    expect(result).toBe(false);
  });

  it("should detect incomplete Unicode escape sequences", () => {
    const badJson = `{"title": "hello\\ud835"}`;
    const result = detectBadJsonStrings(badJson);
    expect(result).toBe(true);
  });

  it("should not detect complete Unicode escape sequences", () => {
    const goodJson = `{"title": "hello\\ud835\\udc00"}`;
    const result = detectBadJsonStrings(goodJson);
    expect(result).toBe(false);
  });

  it("should detect incomplete low surrogate", () => {
    const badJson = `{"title": "hello\\udc00"}`;
    const result = detectBadJsonStrings(badJson);
    expect(result).toBe(true);
  });

  it("should handle multiple Unicode sequences correctly", () => {
    const goodJson = `{"title": "hello\\ud835\\udc00\\ud835\\udc01"}`;
    const result = detectBadJsonStrings(goodJson);
    expect(result).toBe(false);
  });

  it("should detect mixed complete and incomplete sequences", () => {
    const badJson = `{"title": "hello\\ud835\\udc00\\ud835"}`;
    const result = detectBadJsonStrings(badJson);
    expect(result).toBe(true);
  });

  // NOTE: wall-clock microbenchmarks ("acceptable performance overhead",
  // "various JSON sizes efficiently", "significant performance improvement
  // with quick rejection") were removed. They asserted absolute per-call
  // timings (e.g. < 1µs/call) that flake on shared CI runners under load
  // while providing no correctness signal. Behavioural coverage of
  // detectBadJsonStrings lives in the functional cases above and below.

  describe("full UTF-16 low-surrogate range coverage (U+DC00–U+DFFF)", () => {
    // Regression guard: a previous version of this scanner used `[cd]` to
    // match the low-surrogate nibble, missing the entire U+DE00–U+DFFF
    // half of the range. Valid surrogate pairs with low surrogates in that
    // upper half (which includes most common emoji) were falsely flagged,
    // and lone surrogates in the upper half were falsely passed.

    it("does NOT flag a valid pair with low surrogate in the c range (U+DC00–U+DCFF)", () => {
      // 🐍 SNAKE = U+1F40D = 🐍
      expect(detectBadJsonStrings(`{"s":"\\ud83d\\udc0d"}`)).toBe(false);
    });

    it("does NOT flag a valid pair with low surrogate in the d range (U+DD00–U+DDFF)", () => {
      // U+1F540 = 🕀
      expect(detectBadJsonStrings(`{"s":"\\ud83d\\udd40"}`)).toBe(false);
    });

    it("does NOT flag a valid pair with low surrogate in the e range (U+DE00–U+DEFF)", () => {
      // 😀 GRINNING FACE = U+1F600 = 😀 — previously false-flagged
      expect(detectBadJsonStrings(`{"s":"\\ud83d\\ude00"}`)).toBe(false);
    });

    it("does NOT flag a valid pair with low surrogate in the f range (U+DF00–U+DFFF)", () => {
      // U+1F700 = 🜀 — previously false-flagged
      expect(detectBadJsonStrings(`{"s":"\\ud83d\\udf00"}`)).toBe(false);
    });

    it("flags a lone low surrogate in the e range (\\uDE00)", () => {
      // Previously this was NOT flagged because the forward scan only
      // recognised low surrogates with third nibble === "c" || "d".
      expect(detectBadJsonStrings(`{"s":"prefix \\ude00 suffix"}`)).toBe(true);
    });

    it("flags a lone low surrogate in the f range (\\uDFFF)", () => {
      expect(detectBadJsonStrings(`{"s":"prefix \\udfff suffix"}`)).toBe(true);
    });

    it("flags a high surrogate followed by something that looks like a low surrogate but is in the e range with a missing prefix", () => {
      // The previous high-surrogate-then-pair check used `[cd]` for the
      // matching low surrogate nibble, so any high surrogate followed by
      // \uDe.. would be falsely flagged as unpaired. Verify the fix works
      // for the valid case AND still flags genuinely broken inputs.
      expect(detectBadJsonStrings(`{"s":"\\ud800X"}`)).toBe(true); // truly broken
      expect(detectBadJsonStrings(`{"s":"\\ud83d\\ude00"}`)).toBe(false); // valid, but used to flag
    });
  });

  describe("integration with JSON.stringify", () => {
    it("does NOT flag JSON.stringify of a valid emoji 😀", () => {
      // V8 emits the raw character for valid surrogate pairs, so the
      // fast-path returns false without exercising the regex.
      expect(detectBadJsonStrings(JSON.stringify("😀"))).toBe(false);
    });

    it("flags JSON.stringify of a lone high surrogate", () => {
      expect(detectBadJsonStrings(JSON.stringify("\uD800"))).toBe(true);
    });

    it("flags JSON.stringify of a lone low surrogate in each of c/d/e/f ranges", () => {
      expect(detectBadJsonStrings(JSON.stringify("\uDC00"))).toBe(true);
      expect(detectBadJsonStrings(JSON.stringify("\uDD00"))).toBe(true);
      expect(detectBadJsonStrings(JSON.stringify("\uDE00"))).toBe(true);
      expect(detectBadJsonStrings(JSON.stringify("\uDFFF"))).toBe(true);
    });
  });
});
