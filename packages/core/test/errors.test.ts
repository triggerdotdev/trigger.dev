import { describe, it, expect } from "vitest";
import {
  truncateStack,
  truncateMessage,
  parseError,
  sanitizeError,
  shouldRetryError,
  shouldLookupRetrySettings,
  createErrorTaskError,
  createJsonErrorObject,
  formatErrorCauses,
  taskRunErrorEnhancer,
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
      const frameLines = parsed.stackTrace
        .split("\n")
        .filter((l) => l.trimStart().startsWith("at "));
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
      const frameLines = result.stackTrace
        .split("\n")
        .filter((l) => l.trimStart().startsWith("at "));
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
    ({ type: "INTERNAL_ERROR", code }) as TaskRunError;

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

  it("retries TASK_MIDDLEWARE_ERROR using the task's retry settings", () => {
    const err = internal("TASK_MIDDLEWARE_ERROR");
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

describe("parseError cause chains", () => {
  const builtIn = (error: unknown) => {
    const parsed = parseError(error);
    if (parsed.type !== "BUILT_IN_ERROR") {
      throw new Error(`expected BUILT_IN_ERROR, got ${parsed.type}`);
    }
    return parsed;
  };

  it("omits causes when there is no cause", () => {
    expect(builtIn(new Error("boom")).causes).toBeUndefined();
  });

  it("captures a single Error cause", () => {
    const cause = new Error("the real problem");
    cause.name = "TypeError";

    const parsed = builtIn(new Error("A more specific error occurred", { cause }));

    expect(parsed.message).toBe("A more specific error occurred");
    expect(parsed.causes).toHaveLength(1);
    expect(parsed.causes![0]!.name).toBe("TypeError");
    expect(parsed.causes![0]!.message).toBe("the real problem");
    expect(parsed.causes![0]!.stackTrace).toContain("the real problem");
  });

  it("flattens a nested chain outermost first", () => {
    const root = new Error("root");
    const middle = new Error("middle", { cause: root });
    const outer = new Error("outer", { cause: middle });

    expect(builtIn(outer).causes!.map((c) => c.message)).toEqual(["middle", "root"]);
  });

  it("caps the chain at 5 causes", () => {
    let error = new Error("cause-0");
    for (let i = 1; i <= 10; i++) {
      error = new Error(`cause-${i}`, { cause: error });
    }

    expect(builtIn(error).causes).toHaveLength(5);
  });

  it("stops on a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b", { cause: a });
    a.cause = b;

    const causes = builtIn(b).causes!;
    expect(causes.map((c) => c.message)).toEqual(["a"]);
  });

  it("self-referencing cause does not loop", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;

    expect(builtIn(a).causes).toBeUndefined();
  });

  it("serializes a string cause", () => {
    const causes = builtIn(new Error("wrapped", { cause: "just a string" })).causes!;

    expect(causes).toHaveLength(1);
    expect(causes[0]!.message).toBe("just a string");
    expect(causes[0]!.name).toBeUndefined();
  });

  it("serializes a plain-object cause as JSON", () => {
    const causes = builtIn(new Error("wrapped", { cause: { code: "ENOENT" } })).causes!;

    expect(causes[0]!.message).toBe(JSON.stringify({ code: "ENOENT" }));
  });

  it("survives a cause that cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const causes = builtIn(new Error("wrapped", { cause: circular })).causes!;

    expect(causes).toHaveLength(1);
    expect(causes[0]!.message).toBe("[object Object]");
  });

  it("survives a cause that can be neither serialized nor coerced", () => {
    const hostile: Record<string, unknown> = Object.create(null);
    hostile.self = hostile;

    const causes = builtIn(new Error("wrapped", { cause: hostile })).causes!;

    expect(causes).toHaveLength(1);
    expect(causes[0]!.message).toBe("[unserializable object cause]");
  });

  it("survives a cause whose toJSON and toString both throw", () => {
    const hostile = {
      toJSON() {
        throw new Error("no json");
      },
      toString() {
        throw new Error("no string");
      },
    };

    const causes = builtIn(new Error("wrapped", { cause: hostile })).causes!;

    expect(causes).toHaveLength(1);
    expect(causes[0]!.message).toBe("[unserializable object cause]");
  });

  it("survives a cause whose prototype cannot be read", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("no prototype for you");
        },
      }
    );

    expect(() => parseError(new Error("wrapped", { cause: hostile }))).not.toThrow();
  });

  it("survives a revoked Proxy cause", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => parseError(new Error("wrapped", { cause: proxy }))).not.toThrow();
  });

  it("survives a Proxy cause that wraps an Error and throws on every get", () => {
    const hostile = new Proxy(new Error("real"), {
      get() {
        throw new Error("no reads for you");
      },
    });

    const causes = builtIn(new Error("wrapped", { cause: hostile })).causes!;

    expect(causes).toHaveLength(1);
    expect(causes[0]!.message).toBe("[unserializable object cause]");
  });

  it("keeps the causes already collected when a deeper link is hostile", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const inner = new Error("inner", { cause: proxy });
    const causes = builtIn(new Error("outer", { cause: inner })).causes!;

    expect(causes[0]!.message).toBe("inner");
  });

  it("drops a cause that carries nothing to show", () => {
    expect(builtIn(new Error("wrapped", { cause: "" })).causes).toBeUndefined();
  });

  it("keeps a symbol cause, which JSON.stringify drops", () => {
    const causes = builtIn(new Error("wrapped", { cause: Symbol("boom") })).causes!;

    expect(causes[0]!.message).toBe("Symbol(boom)");
  });

  it("ignores a null cause", () => {
    expect(builtIn(new Error("wrapped", { cause: null })).causes).toBeUndefined();
  });

  it("gives cause stacks a tighter frame budget than the thrown error", () => {
    const cause = new Error("deep");
    cause.stack = buildStack(["Error: deep"], 100);
    const outer = new Error("outer", { cause });
    outer.stack = buildStack(["Error: outer"], 100);

    const parsed = builtIn(outer);
    const frames = (stack: string) =>
      stack.split("\n").filter((l) => l.trimStart().startsWith("at ")).length;

    expect(frames(parsed.stackTrace)).toBe(50);
    expect(frames(parsed.causes![0]!.stackTrace!)).toBe(10);
    expect(parsed.causes![0]!.stackTrace).toContain("frames omitted");
  });

  it("truncates an oversized cause name", () => {
    const cause = new Error("inner");
    cause.name = "N".repeat(5000);

    const causes = builtIn(new Error("wrapped", { cause })).causes!;

    expect(causes[0]!.name!.length).toBe(256);
  });

  it("truncates oversized cause messages", () => {
    const cause = new Error("x".repeat(5000));
    const causes = builtIn(new Error("wrapped", { cause })).causes!;

    expect(causes[0]!.message.length).toBeLessThan(1100);
    expect(causes[0]!.message).toContain("...[truncated]");
  });
});

describe("sanitizeError cause chains", () => {
  it("strips null bytes and keeps the chain", () => {
    const result = sanitizeError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "Error: outer\n    at fn (/path.ts:1:1)",
      causes: [{ name: "Type\0Error", message: "in\0ner", stackTrace: "TypeError: in\0ner" }],
    });

    if (result.type !== "BUILT_IN_ERROR") throw new Error("wrong type");
    expect(result.causes).toHaveLength(1);
    expect(result.causes![0]!.name).toBe("TypeError");
    expect(result.causes![0]!.message).toBe("inner");
    expect(result.causes![0]!.stackTrace).not.toContain("\0");
  });

  it("leaves causes absent when there were none", () => {
    const result = sanitizeError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "",
    });

    if (result.type !== "BUILT_IN_ERROR") throw new Error("wrong type");
    expect("causes" in result).toBe(false);
  });

  it("truncates an oversized cause name on stored rows too", () => {
    const result = sanitizeError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "",
      causes: [{ name: "N".repeat(5000), message: "inner" }],
    });

    if (result.type !== "BUILT_IN_ERROR") throw new Error("wrong type");
    expect(result.causes![0]!.name!.length).toBe(256);
  });

  it("caps an oversized stored chain", () => {
    const result = sanitizeError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "",
      causes: Array.from({ length: 20 }, (_, i) => ({ message: `cause-${i}` })),
    });

    if (result.type !== "BUILT_IN_ERROR") throw new Error("wrong type");
    expect(result.causes).toHaveLength(5);
  });
});

describe("createErrorTaskError cause chains", () => {
  it("round-trips a cause chain back onto a native Error", () => {
    const original = new Error("outer", { cause: new Error("inner", { cause: "root" }) });
    const rebuilt = createErrorTaskError(parseError(original)) as Error & { cause?: any };

    expect(rebuilt.message).toBe("outer");
    expect(rebuilt.cause).toBeInstanceOf(Error);
    expect(rebuilt.cause.message).toBe("inner");
    expect(rebuilt.cause.cause).toBeInstanceOf(Error);
    expect(rebuilt.cause.cause.message).toBe("root");
    expect(rebuilt.cause.cause.cause).toBeUndefined();
  });

  it("installs no cause property at all when there is no chain", () => {
    const rebuilt = createErrorTaskError(parseError(new Error("outer"))) as Error;

    expect("cause" in rebuilt).toBe(false);
  });

  it("installs no cause property for a stored empty chain", () => {
    const rebuilt = createErrorTaskError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "",
      causes: [],
    }) as Error;

    expect("cause" in rebuilt).toBe(false);
  });
});

describe("taskRunErrorEnhancer cause chains", () => {
  const withCauses = (name: string, message: string): TaskRunError => ({
    type: "BUILT_IN_ERROR",
    name,
    message,
    stackTrace: "",
    causes: [{ name: "TypeError", message: "inner" }],
  });

  it("keeps causes through the deadlock rewrite, the one built-in to built-in branch", () => {
    const enhanced = taskRunErrorEnhancer(
      withCauses("TriggerApiError", "Deadlock detected: two runs waiting")
    );

    expect(enhanced.type).toBe("BUILT_IN_ERROR");
    if (enhanced.type !== "BUILT_IN_ERROR") throw new Error("wrong type");
    expect(enhanced.name).toBe("Concurrency Deadlock Error");
    expect(enhanced.causes).toEqual([{ name: "TypeError", message: "inner" }]);
  });

  it("keeps causes when the enhancer passes an error through untouched", () => {
    const enhanced = taskRunErrorEnhancer(withCauses("Error", "just a normal failure"));

    if (enhanced.type !== "BUILT_IN_ERROR") throw new Error("wrong type");
    expect(enhanced.causes).toEqual([{ name: "TypeError", message: "inner" }]);
  });

  it("serializes the deadlock rewrite with its causes intact", () => {
    const serialized = createJsonErrorObject(
      withCauses("TriggerApiError", "Deadlock detected: two runs waiting")
    );

    expect(serialized.causes).toEqual([{ name: "TypeError", message: "inner" }]);
  });
});

describe("createJsonErrorObject cause chains", () => {
  it("includes causes in the serialized error", () => {
    const serialized = createJsonErrorObject(
      parseError(new Error("outer", { cause: new Error("inner") }))
    );

    expect(serialized.causes).toHaveLength(1);
    expect(serialized.causes![0]!.message).toBe("inner");
  });

  it("omits causes when there are none", () => {
    expect(createJsonErrorObject(parseError(new Error("outer"))).causes).toBeUndefined();
  });
});

describe("createErrorFromCauses stacks", () => {
  it("does not fabricate a stack pointing into the runtime", () => {
    const rebuilt = createErrorTaskError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "Error: outer",
      causes: [{ message: "a string cause" }],
    }) as Error & { cause: Error };

    expect(rebuilt.cause.stack).toBe("a string cause");
    expect(rebuilt.cause.stack).not.toContain("    at ");
  });

  it("keeps a stored cause stack verbatim", () => {
    const rebuilt = createErrorTaskError({
      type: "BUILT_IN_ERROR",
      name: "Error",
      message: "outer",
      stackTrace: "Error: outer",
      causes: [{ name: "TypeError", message: "inner", stackTrace: "TypeError: inner\n    at fn" }],
    }) as Error & { cause: Error };

    expect(rebuilt.cause.name).toBe("TypeError");
    expect(rebuilt.cause.stack).toBe("TypeError: inner\n    at fn");
  });
});

describe("formatErrorCauses", () => {
  it("returns an empty string for no causes", () => {
    expect(formatErrorCauses(undefined)).toBe("");
    expect(formatErrorCauses([])).toBe("");
  });

  it("renders one line per cause by default", () => {
    expect(
      formatErrorCauses([
        { name: "TypeError", message: "inner", stackTrace: "TypeError: inner\n    at fn" },
        { message: "root" },
      ])
    ).toBe("\nCaused by: TypeError: inner\nCaused by: root");
  });

  it("emits nothing for a cause that carries no name or message", () => {
    expect(formatErrorCauses([{ message: "" }])).toBe("");
    expect(formatErrorCauses([{ message: "" }, { message: "real" }])).toBe("\nCaused by: real");
  });

  it("renders full frames when asked", () => {
    expect(
      formatErrorCauses([{ name: "TypeError", message: "inner", stackTrace: "TypeError: inner" }], {
        stackTrace: true,
      })
    ).toBe("\n\nCaused by: TypeError: inner");
  });
});
