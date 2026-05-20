import { describe, it, expect } from "vitest";
import {
  INVALID_UTF16_SENTINEL,
  isClickHouseJsonParseError,
  parseRowNumberFromError,
  sanitizeRows,
  sanitizeUnknownInPlace,
} from "~/v3/eventRepository/sanitizeRowsOnParseError.server";

const HIGH_SURROGATE = "\uD800";
const LOW_SURROGATE = "\uDC00";

describe("isClickHouseJsonParseError", () => {
  it("recognises ClickHouse's parse-error string", () => {
    const err = new Error(
      "Cannot parse JSON object here: {...}: (while reading the value of key attributes): (at row 15)\n: While executing ParallelParsingBlockInputFormat. "
    );
    expect(isClickHouseJsonParseError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isClickHouseJsonParseError(new Error("Connection refused"))).toBe(false);
    expect(
      isClickHouseJsonParseError(
        new Error("Size of JSON object at position 999 is extremely large.")
      )
    ).toBe(false);
  });

  it("returns false for null / undefined / strings", () => {
    expect(isClickHouseJsonParseError(null)).toBe(false);
    expect(isClickHouseJsonParseError(undefined)).toBe(false);
    expect(isClickHouseJsonParseError("Cannot parse JSON object")).toBe(true);
  });
});

describe("parseRowNumberFromError", () => {
  it("extracts the row index from a typical ClickHouse error message", () => {
    expect(
      parseRowNumberFromError(
        "Cannot parse JSON object here: { ... }: (while reading the value of key attributes): (at row 1942)\n: While executing ParallelParsingBlockInputFormat."
      )
    ).toBe(1942);
  });

  it("returns null when no row index is present", () => {
    expect(parseRowNumberFromError("Some other error without a row hint")).toBeNull();
  });

  it("returns the first match when multiple `at row N` substrings exist", () => {
    expect(parseRowNumberFromError("at row 1, oops also at row 2")).toBe(1);
  });
});

describe("sanitizeUnknownInPlace", () => {
  it("returns the string unchanged when it has no surrogates", () => {
    const result = sanitizeUnknownInPlace("hello world");
    expect(result).toEqual({ value: "hello world", fixed: 0 });
  });

  it("replaces a lone-surrogate string with the sentinel", () => {
    const result = sanitizeUnknownInPlace(`prefix ${HIGH_SURROGATE} suffix`);
    expect(result.value).toBe(INVALID_UTF16_SENTINEL);
    expect(result.fixed).toBe(1);
  });

  it("leaves valid surrogate pairs (emoji) intact", () => {
    const result = sanitizeUnknownInPlace("hello 😀 world");
    expect(result.value).toBe("hello 😀 world");
    expect(result.fixed).toBe(0);
  });

  it("walks nested objects and mutates string leaves in place", () => {
    const row = {
      id: "row-1",
      attributes: {
        ai: {
          prompt: { messages: `bad ${HIGH_SURROGATE} string` },
          usage: { input_tokens: 42 },
        },
        clean: "untouched",
      },
    };
    const result = sanitizeUnknownInPlace(row);
    expect(result.fixed).toBe(1);
    expect((row.attributes.ai.prompt as any).messages).toBe(INVALID_UTF16_SENTINEL);
    expect(row.attributes.clean).toBe("untouched");
    expect((row.attributes.ai.usage as any).input_tokens).toBe(42);
    expect(row.id).toBe("row-1");
  });

  it("walks arrays recursively", () => {
    const value = ["ok", `bad ${LOW_SURROGATE} value`, "also ok", { nested: `also bad ${HIGH_SURROGATE}` }];
    const result = sanitizeUnknownInPlace(value);
    expect(result.fixed).toBe(2);
    expect(value[1]).toBe(INVALID_UTF16_SENTINEL);
    expect((value[3] as any).nested).toBe(INVALID_UTF16_SENTINEL);
    expect(value[0]).toBe("ok");
    expect(value[2]).toBe("also ok");
  });

  it("leaves non-string primitives untouched", () => {
    expect(sanitizeUnknownInPlace(42)).toEqual({ value: 42, fixed: 0 });
    expect(sanitizeUnknownInPlace(true)).toEqual({ value: true, fixed: 0 });
    expect(sanitizeUnknownInPlace(null)).toEqual({ value: null, fixed: 0 });
    expect(sanitizeUnknownInPlace(undefined)).toEqual({ value: undefined, fixed: 0 });
  });
});

describe("sanitizeRows", () => {
  function makeRow(suffix: string, badField?: string) {
    return {
      id: `row-${suffix}`,
      attributes: { foo: badField ?? "clean" },
    };
  }

  it("sanitizes every row that has bad strings", () => {
    const rows = [
      makeRow("0", `bad-0-${HIGH_SURROGATE}`),
      makeRow("1", `bad-1-${HIGH_SURROGATE}`),
      makeRow("2", "clean"),
      makeRow("3", `bad-3-${HIGH_SURROGATE}`),
    ];

    const result = sanitizeRows(rows);

    expect(rows[0].attributes.foo).toBe(INVALID_UTF16_SENTINEL);
    expect(rows[1].attributes.foo).toBe(INVALID_UTF16_SENTINEL);
    expect(rows[2].attributes.foo).toBe("clean");
    expect(rows[3].attributes.foo).toBe(INVALID_UTF16_SENTINEL);
    expect(result.rowsTouched).toBe(3);
    expect(result.fieldsSanitized).toBe(3);
  });

  it("returns zero counts when no row has bad strings", () => {
    const rows = [makeRow("0"), makeRow("1"), makeRow("2")];
    const result = sanitizeRows(rows);
    expect(result).toEqual({ rowsTouched: 0, fieldsSanitized: 0 });
  });

  it("returns zero counts for an empty batch", () => {
    expect(sanitizeRows([])).toEqual({ rowsTouched: 0, fieldsSanitized: 0 });
  });

  it("counts multiple sanitized fields on the same row as one rowTouched but multiple fields", () => {
    const rows = [
      {
        id: "r0",
        attributes: {
          a: `bad ${HIGH_SURROGATE}`,
          b: `also bad ${LOW_SURROGATE}`,
          c: "fine",
        },
      },
    ];
    const result = sanitizeRows(rows);
    expect(result.rowsTouched).toBe(1);
    expect(result.fieldsSanitized).toBe(2);
  });
});
