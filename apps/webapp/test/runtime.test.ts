import { describe, expect, it } from "vitest";
import { formatRuntimeWithVersion, parseRuntime } from "~/utils/runtime";

describe("parseRuntime", () => {
  it("normalizes bun runtimes", () => {
    expect(parseRuntime("bun")).toEqual({
      runtime: "bun",
      originalRuntime: "bun",
      displayName: "Bun",
    });
    expect(parseRuntime("bun-1.2")).toEqual({
      runtime: "bun",
      originalRuntime: "bun-1.2",
      displayName: "Bun",
    });
  });

  it("normalizes node runtimes", () => {
    expect(parseRuntime("node")).toEqual({
      runtime: "node",
      originalRuntime: "node",
      displayName: "Node.js",
    });
    expect(parseRuntime("node-24")).toEqual({
      runtime: "node",
      originalRuntime: "node-24",
      displayName: "Node.js",
    });
  });

  it("returns null for a missing runtime instead of assuming node", () => {
    expect(parseRuntime(null)).toBeNull();
    expect(parseRuntime(undefined)).toBeNull();
    expect(parseRuntime("")).toBeNull();
  });

  it("returns null for an unrecognized runtime", () => {
    expect(parseRuntime("deno")).toBeNull();
    expect(parseRuntime("python3.12")).toBeNull();
    expect(parseRuntime("Node")).toBeNull();
  });
});

describe("formatRuntimeWithVersion", () => {
  it("appends the version when there is one", () => {
    expect(formatRuntimeWithVersion("bun", "1.2.23")).toBe("Bun v1.2.23");
    expect(formatRuntimeWithVersion("node-24", "24.9.0")).toBe("Node.js v24.9.0");
  });

  it("falls back to the display name without a version", () => {
    expect(formatRuntimeWithVersion("bun", null)).toBe("Bun");
    expect(formatRuntimeWithVersion("node-24", undefined)).toBe("Node.js");
    expect(formatRuntimeWithVersion("node", "")).toBe("Node.js");
  });

  it("reports an unknown runtime rather than a default", () => {
    expect(formatRuntimeWithVersion(null, null)).toBe("Unknown runtime");
    expect(formatRuntimeWithVersion(undefined, "24.9.0")).toBe("Unknown runtime");
    expect(formatRuntimeWithVersion("deno", "2.1.0")).toBe("Unknown runtime");
  });
});
