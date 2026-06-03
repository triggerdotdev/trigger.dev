import { describe, it, expect } from "vitest";
import { parseTraceId } from "./traceparent.js";

describe("parseTraceId", () => {
  const validTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const validHeader = `00-${validTraceId}-00f067aa0ba902b7-01`;

  it("extracts the trace-id from a valid W3C traceparent", () => {
    expect(parseTraceId(validHeader)).toBe(validTraceId);
  });

  it("returns empty string for empty/null/undefined input", () => {
    expect(parseTraceId("")).toBe("");
    expect(parseTraceId(null)).toBe("");
    expect(parseTraceId(undefined)).toBe("");
  });

  it("returns empty for wrong segment count", () => {
    expect(parseTraceId("00-abc-def")).toBe("");
    expect(parseTraceId("00-abc-def-01-extra")).toBe("");
  });

  it("returns empty for non-zero version byte", () => {
    expect(parseTraceId(`01-${validTraceId}-00f067aa0ba902b7-01`)).toBe("");
  });

  it("returns empty for wrong-length trace-id", () => {
    expect(parseTraceId("00-abc-00f067aa0ba902b7-01")).toBe("");
  });

  it("returns empty for non-hex trace-id", () => {
    expect(parseTraceId("00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01")).toBe("");
  });

  it("returns empty for all-zero trace-id", () => {
    expect(parseTraceId("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBe("");
  });

  it("accepts uppercase hex", () => {
    const tid = "4BF92F3577B34DA6A3CE929D0E0E4736";
    expect(parseTraceId(`00-${tid}-00f067aa0ba902b7-01`)).toBe(tid);
  });
});
