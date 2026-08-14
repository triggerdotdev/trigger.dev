import { describe, expect, it } from "vitest";
import {
  escapeClickHouseLike,
  hasMinimumLogsSearchLength,
  normalizeLogsSearchTerm,
  prepareLogsSearchPage,
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

  it("removes projector retry copies after bounded overfetch", () => {
    const row = (fingerprint: string) => ({
      projection_fingerprint_string: fingerprint,
      trace_id: `trace_${fingerprint}`,
      span_id: `span_${fingerprint}`,
      run_id: `run_${fingerprint}`,
      start_time: "2026-08-14 12:00:00.000000000",
    });
    const page = prepareLogsSearchPage([row("a"), row("a"), row("b"), row("c"), row("d")], 2, 5);

    expect(page.rows.map((item) => item.projection_fingerprint_string)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(true);
  });

  it("keeps pagination open when retries fill the overfetch bound", () => {
    const duplicate = {
      projection_fingerprint_string: "same",
      trace_id: "trace",
      span_id: "span",
      run_id: "run",
      start_time: "2026-08-14 12:00:00.000000000",
    };

    expect(prepareLogsSearchPage([duplicate, duplicate, duplicate, duplicate], 2, 4)).toEqual({
      rows: [duplicate],
      hasMore: true,
    });
  });
});
