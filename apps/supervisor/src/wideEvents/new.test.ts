import { describe, it, expect } from "vitest";
import { isValidRequestId, newState } from "./new.js";

describe("isValidRequestId", () => {
  it("accepts visible ASCII", () => {
    expect(isValidRequestId("req-abc-123_456.7")).toBe(true);
    expect(isValidRequestId("a")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidRequestId("")).toBe(false);
  });

  it("rejects overlong strings (>128 bytes)", () => {
    expect(isValidRequestId("a".repeat(128))).toBe(true);
    expect(isValidRequestId("a".repeat(129))).toBe(false);
  });

  it("rejects whitespace, newlines, control chars", () => {
    expect(isValidRequestId("has space")).toBe(false);
    expect(isValidRequestId("has\ttab")).toBe(false);
    expect(isValidRequestId("has\nnewline")).toBe(false);
    expect(isValidRequestId("\x00null")).toBe(false);
  });

  it("rejects high-bit / non-ASCII", () => {
    expect(isValidRequestId("café")).toBe(false);
    expect(isValidRequestId("a\x7f")).toBe(false);
  });
});

describe("newState", () => {
  const env = { version: "1.0.0", commitSha: "abc123", region: "us-east-1", nodeId: "node-1" };

  it("populates service identity from env", () => {
    const s = newState({ service: "supervisor", env });
    expect(s.service).toBe("supervisor");
    expect(s.version).toBe("1.0.0");
    expect(s.commitSha).toBe("abc123");
    expect(s.region).toBe("us-east-1");
    expect(s.nodeId).toBe("node-1");
  });

  it("mints a fresh request id when none provided", () => {
    const s = newState({ service: "test", env: {} });
    expect(s.requestId).toMatch(/^req-[0-9a-f]{32}$/);
  });

  it("honours a valid inbound request id", () => {
    const s = newState({ service: "test", env: {}, inboundRequestId: "trace-abc-123" });
    expect(s.requestId).toBe("trace-abc-123");
  });

  it("rejects unsafe inbound request id and mints a fresh one", () => {
    const s = newState({ service: "test", env: {}, inboundRequestId: "has space" });
    expect(s.requestId).toMatch(/^req-[0-9a-f]{32}$/);
  });

  it("parses traceparent into traceId and preserves the raw header", () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const s = newState({ service: "test", env: {}, traceparent: tp });
    expect(s.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(s.traceparent).toBe(tp);
  });

  it("leaves traceId empty when no traceparent provided", () => {
    const s = newState({ service: "test", env: {} });
    expect(s.traceId).toBe("");
    expect(s.traceparent).toBe("");
  });

  it("initialises empty meta/extras/phases", () => {
    const s = newState({ service: "test", env: {} });
    expect(s.meta).toEqual({});
    expect(s.extras).toEqual({});
    expect(s.phases).toEqual([]);
    expect(s.ok).toBe(false);
    expect(s.statusCode).toBe(0);
    expect(s.durationMs).toBe(0);
  });
});
