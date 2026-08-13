import { describe, expect, it } from "vitest";
import {
  escapeClickHouseLike,
  hasMinimumLogsSearchLength,
  normalizeLogsSearchTerm,
} from "./logSearch";

describe("log search normalization", () => {
  it("normalizes punctuation while preserving unicode, paths, and ids", () => {
    expect(
      normalizeLogsSearchTerm("TypeError: Zahlungsübersicht failed, retrying (/api/orders/42)")
    ).toBe("typeerror: zahlungsübersicht failed retrying /api/orders/42");
  });

  it("escapes LIKE wildcards without escaping path separators", () => {
    expect(escapeClickHouseLike("/api/a_b/100%")).toBe("/api/a\\_b/100\\%");
  });

  it("requires at least three unicode characters after trimming", () => {
    expect(hasMinimumLogsSearchLength("ab")).toBe(false);
    expect(hasMinimumLogsSearchLength("  ab  ")).toBe(false);
    expect(hasMinimumLogsSearchLength("abc")).toBe(true);
    expect(hasMinimumLogsSearchLength("日本語")).toBe(true);
  });
});
