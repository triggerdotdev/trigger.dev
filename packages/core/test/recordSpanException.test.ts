import { describe, it, expect, vi } from "vitest";
import { recordSpanException } from "../src/v3/otel/utils.js";
import type { Span } from "@opentelemetry/api";

function createMockSpan() {
  return {
    recordException: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as Span & { recordException: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
}

describe("recordSpanException", () => {
  it("records Error instances with truncated message and stack", () => {
    const span = createMockSpan();
    const error = new Error("x".repeat(5_000));
    recordSpanException(span, error);

    expect(span.recordException).toHaveBeenCalledTimes(1);
    const recorded = (span.recordException as any).mock.calls[0][0] as Error;
    expect(recorded).toBeInstanceOf(Error);
    expect(recorded.message.length).toBeLessThan(1100);
  });

  it("records string errors with truncation", () => {
    const span = createMockSpan();
    recordSpanException(span, "x".repeat(10_000));

    const recorded = (span.recordException as any).mock.calls[0][0] as string;
    expect(typeof recorded).toBe("string");
    expect(recorded.length).toBeLessThan(5_100);
    expect(recorded).toContain("...[truncated]");
  });

  it("does not throw on circular references", () => {
    const span = createMockSpan();
    const circular: any = { foo: "bar" };
    circular.self = circular;

    expect(() => recordSpanException(span, circular)).not.toThrow();
    expect(span.recordException).toHaveBeenCalledTimes(1);
    expect(span.setStatus).toHaveBeenCalledTimes(1);
  });

  it("does not throw on BigInt values", () => {
    const span = createMockSpan();
    const error = { count: BigInt(123) };

    expect(() => recordSpanException(span, error)).not.toThrow();
    expect(span.recordException).toHaveBeenCalledTimes(1);
  });

  it("handles symbol values (JSON.stringify returns undefined)", () => {
    const span = createMockSpan();
    const sym = Symbol("test");

    expect(() => recordSpanException(span, sym)).not.toThrow();
    expect(span.recordException).toHaveBeenCalledTimes(1);
    const recorded = (span.recordException as any).mock.calls[0][0] as string;
    expect(typeof recorded).toBe("string");
    expect(recorded).toContain("Symbol");
  });

  it("handles function values (JSON.stringify returns undefined)", () => {
    const span = createMockSpan();
    const fn = () => "test";

    expect(() => recordSpanException(span, fn)).not.toThrow();
    expect(span.recordException).toHaveBeenCalledTimes(1);
  });

  it("handles undefined (JSON.stringify returns undefined)", () => {
    const span = createMockSpan();

    expect(() => recordSpanException(span, undefined)).not.toThrow();
    expect(span.recordException).toHaveBeenCalledTimes(1);
    const recorded = (span.recordException as any).mock.calls[0][0] as string;
    expect(typeof recorded).toBe("string");
  });

  it("always calls setStatus ERROR", () => {
    const span = createMockSpan();
    recordSpanException(span, new Error("test"));
    recordSpanException(span, "string");
    recordSpanException(span, { obj: true });

    expect(span.setStatus).toHaveBeenCalledTimes(3);
  });
});
