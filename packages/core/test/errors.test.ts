import { describe, it, expect } from "vitest";
import {
  truncateStack,
  truncateMessage,
  parseError,
  sanitizeError,
  shouldRetryError,
  shouldLookupRetrySettings,
} from "../src/v3/errors.js";
import type { TaskRunError } from "../src/v3/schemas/common.js";

// Helper: build a fake stack with N frames
function buildStack(messageLines: string[], frameCount: number): string {
  const frames = Array.from(
    { length: frameCount },
    (_, i) => `    at functionName${i} (/path/to/file${i}.ts:${i + 1}:${i + 10})`
  );
  return [...messageLines, ...frames].join("\n");
}

describe("truncateStack", () => {
  it("returns empty string for undefined", () => {
    expect(truncateStack(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(truncateStack("")).toBe("");
  });

  it("preserves a short stack unchanged", () => {
    const stack = buildStack(["Error: something broke"], 10);
    expect(truncateStack(stack)).toBe(stack);
  });

  it("preserves exactly 50 frames", () => {
    const stack = buildStack(["Error: at the limit"], 50);
    const result = truncateStack(stack);
    expect(result).toBe(stack);
    expect(result.split("\n").filter((l) => l.trimStart().startsWith("at ")).length).toBe(50);
  });

  it("truncates to 50 frames when exceeding the limit", () => {
    const stack = buildStack(["Error: too many frames"], 200);
    const result = truncateStack(stack);
    const lines = result.split("\n");

    // Message line + 5 top + 1 omitted notice + 45 bottom = 52 lines
    expect(lines[0]).toBe("Error: too many frames");
    expect(lines).toContain("    ... 150 frames omitted ...");

    const frameLines = lines.filter((l) => l.trimStart().startsWith("at "));
    expect(frameLines.length).toBe(50);

    // First kept frame is frame 0 (top of stack)
    expect(frameLines[0]).toContain("functionName0");
    // Last kept frame is the last original frame
    expect(frameLines[frameLines.length - 1]).toContain("functionName199");
  });

  it("preserves multi-line error messages before frames", () => {
    const stack = buildStack(["TypeError: cannot read property", "  caused by: something"], 60);
    const result = truncateStack(stack);
    const lines = result.split("\n");

    expect(lines[0]).toBe("TypeError: cannot read property");
    expect(lines[1]).toBe("  caused by: something");
    expect(lines).toContain("    ... 10 frames omitted ...");
  });

  it("truncates individual lines longer than 1024 chars", () => {
    const longFrame = `    at someFn (${"x".repeat(2000)}:1:1)`;
    const stack = ["Error: long line", longFrame].join("\n");
    const result = truncateStack(stack);
    const frameLine = result.split("\n")[1]!;

    expect(frameLine.length).toBeLessThan(1100);
    expect(frameLine).toContain("...[truncated]");
  });
});

describe("truncateMessage", () => {
  it("returns empty string for undefined", () => {
    expect(truncateMessage(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(truncateMessage("")).toBe("");
  });

  it("preserves a short message", () => {
    expect(truncateMessage("hello")).toBe("hello");
  });

  it("truncates messages over 1000 chars", () => {
    const long = "x".repeat(5000);
    const result = truncateMessage(long);
    expect(result.length).toBeLessThan(1100);
    expect(result).toContain("...[truncated]");
  });

  it("preserves a message at exactly 1000 chars", () => {
    const exact = "x".repeat(1000);
    expect(truncateMessage(exact)).toBe(exact);
  });
});

describe("parseError truncation", () => {
  it("truncates large stack traces in Error objects", () => {
    const error = new Error("boom");
    error.stack = buildStack(["Error: boom"], 200);
    const parsed = parseError(error);

    expect(parsed.type).toBe("BUILT_IN_ERROR");
    if (parsed.type === "BUILT_IN_ERROR") {
      const frameLines = parsed.stackTrace.split("\n").filter((l) => l.trimStart().startsWith("at "));
      expect(frameLines.length).toBe(50);
      expect(parsed.stackTrace).toContain("frames omitted");
    }
  });

  it("truncates large error messages", () => {
    const error = new Error("x".repeat(5000));
    const parsed = parseError(error);

    if (parsed.type === "BUILT_IN_ERROR") {
      expect(parsed.message.length).toBeLessThan(1100);
      expect(parsed.message).toContain("...[truncated]");
    }
  });
});

describe("sanitizeError truncation", () => {
  it("truncates stack traces during sanitization", () => {
    const result = sanitizeError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "boom",
      stackTrace: buildStack(["Error: boom"], 200),
    });

    if (result.type === "BUILT_IN_ERROR") {
      const frameLines = result.stackTrace.split("\n").filter((l) => l.trimStart().startsWith("at "));
      expect(frameLines.length).toBe(50);
    }
  });

  it("strips null bytes and truncates", () => {
    const result = sanitizeError({
      type: "BUILT_IN_ERROR",
      name: "Error\0",
      message: "hello\0world",
      stackTrace: "Error: hello\0world\n    at fn (/path.ts:1:1)",
    });

    if (result.type === "BUILT_IN_ERROR") {
      expect(result.name).toBe("Error");
      expect(result.message).toBe("helloworld");
      expect(result.stackTrace).not.toContain("\0");
    }
  });

  it("truncates STRING_ERROR raw field", () => {
    const result = sanitizeError({
      type: "STRING_ERROR",
      raw: "x".repeat(5000),
    });

    if (result.type === "STRING_ERROR") {
      expect(result.raw.length).toBeLessThan(1100);
      expect(result.raw).toContain("...[truncated]");
    }
  });

  it("preserves small CUSTOM_ERROR raw as valid JSON", () => {
    const originalJson = JSON.stringify({ foo: "bar", nested: { baz: 1 } });
    const result = sanitizeError({
      type: "CUSTOM_ERROR",
      raw: originalJson,
    });

    if (result.type === "CUSTOM_ERROR") {
      // Small JSON should pass through unchanged and remain parseable
      expect(result.raw).toBe(originalJson);
      expect(() => JSON.parse(result.raw)).not.toThrow();
    }
  });

  it("wraps oversized CUSTOM_ERROR raw in a valid JSON envelope", () => {
    const hugeJson = JSON.stringify({ data: "x".repeat(5000) });
    const result = sanitizeError({
      type: "CUSTOM_ERROR",
      raw: hugeJson,
    });

    if (result.type === "CUSTOM_ERROR") {
      // Must remain valid JSON (critical: createErrorTaskError calls JSON.parse on this)
      expect(() => JSON.parse(result.raw)).not.toThrow();
      const parsed = JSON.parse(result.raw);
      expect(parsed.truncated).toBe(true);
      expect(typeof parsed.preview).toBe("string");
      expect(parsed.preview.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("sanitizeError INTERNAL_ERROR optional fields", () => {
  it("preserves undefined message (does not convert to empty string)", () => {
    const result = sanitizeError({
      type: "INTERNAL_ERROR",
      code: "SOME_INTERNAL_CODE" as any,
      // message and stackTrace intentionally undefined
    });

    if (result.type === "INTERNAL_ERROR") {
      // Must stay undefined so `error.message ?? fallback` works downstream
      expect(result.message).toBeUndefined();
      expect(result.stackTrace).toBeUndefined();
    }
  });

  it("truncates INTERNAL_ERROR message when present", () => {
    const result = sanitizeError({
      type: "INTERNAL_ERROR",
      code: "SOME_INTERNAL_CODE" as any,
      message: "x".repeat(5000),
    });

    if (result.type === "INTERNAL_ERROR") {
      expect(result.message).toBeDefined();
      expect(result.message!.length).toBeLessThan(1100);
      expect(result.message).toContain("...[truncated]");
    }
  });
});

describe("truncateStack message line bounding", () => {
  it("truncates huge error messages embedded in the stack", () => {
    // V8 format: "Error: <message>\n    at ..."
    // A huge message on the first line must still be bounded.
    const hugeMessage = "x".repeat(100_000);
    const stack = `Error: ${hugeMessage}\n    at fn (/path.ts:1:1)`;
    const result = truncateStack(stack);

    // Total output should be bounded (not 100KB+)
    expect(result.length).toBeLessThan(5_000);
    expect(result).toContain("...[truncated]");
  });
});

describe("shouldRetryError + shouldLookupRetrySettings", () => {
  const internal = (code: string): TaskRunError =>
    ({ type: "INTERNAL_ERROR", code } as TaskRunError);

  it("retries SIGSEGV (changed from non-retriable) and looks up retry settings", () => {
    const err = internal("TASK_PROCESS_SIGSEGV");
    expect(shouldRetryError(err)).toBe(true);
    expect(shouldLookupRetrySettings(err)).toBe(true);
  });

  it("retries SIGTERM via the same path", () => {
    const err = internal("TASK_PROCESS_SIGTERM");
    expect(shouldRetryError(err)).toBe(true);
    expect(shouldLookupRetrySettings(err)).toBe(true);
  });

  it("still does not retry SIGKILL timeout", () => {
    expect(shouldRetryError(internal("TASK_PROCESS_SIGKILL_TIMEOUT"))).toBe(false);
  });

  it("still does not retry OOM kills (handled by the separate machine-bump path)", () => {
    expect(shouldRetryError(internal("TASK_PROCESS_OOM_KILLED"))).toBe(false);
    expect(shouldRetryError(internal("TASK_PROCESS_MAYBE_OOM_KILLED"))).toBe(false);
  });
});
