import { describe, expect, it } from "vitest";
import { BuildManifest, BuildRuntime, ConfigRuntime, WorkerManifest } from "../schemas/build.js";
import {
  binaryForRuntime,
  isBunRuntime,
  isDeprecatedConfigRuntime,
  isNodelessBunRuntime,
  resolveBuildRuntime,
} from "./runtime.js";

describe("runtime configuration", () => {
  it.each([
    "node",
    "node-22",
    "node-24",
    "node-26",
    "experimental-node-24",
    "experimental-node-26",
    "bun",
    "bun-legacy",
    "bun-1.4",
  ] as const)("accepts %s as a public config runtime", (runtime) => {
    expect(ConfigRuntime.parse(runtime)).toBe(runtime);
  });

  it.each([
    ["experimental-node-24", "node-24"],
    ["experimental-node-26", "node-26"],
    ["node", "node-24"],
    ["node-22", "node-22"],
    ["node-24", "node-24"],
    ["node-26", "node-26"],
    ["bun", "bun"],
    ["bun-legacy", "bun-legacy"],
    ["bun-1.4", "bun-1.4"],
  ] as const)("normalizes %s to %s", (runtime, expected) => {
    expect(resolveBuildRuntime(runtime)).toBe(expected);
  });

  it("normalizes an omitted runtime to node-24", () => {
    expect(resolveBuildRuntime(undefined)).toBe("node-24");
  });

  it("keeps bun valid in the internal runtime schemas so existing bundles and extensions still work", () => {
    expect(BuildRuntime.safeParse("bun").success).toBe(true);
    expect(BuildManifest.shape.runtime.safeParse("bun").success).toBe(true);
    expect(WorkerManifest.shape.runtime.safeParse("bun").success).toBe(true);
  });

  it.each(["bun", "bun-legacy", "bun-1.4"] as const)("runs %s with the bun binary", (runtime) => {
    expect(binaryForRuntime(runtime)).toBe("bun");
  });

  it("classifies bun runtimes, including the alias already-deployed workers report", () => {
    for (const runtime of ["bun", "bun-legacy", "bun-1.4", "bun-1.5"]) {
      expect(isBunRuntime(runtime)).toBe(true);
    }
    for (const runtime of ["node", "node-24", "bunx", undefined, null, ""]) {
      expect(isBunRuntime(runtime)).toBe(false);
    }
  });

  it("only treats the versioned bun runtimes as node-less", () => {
    for (const runtime of ["bun-1.4", "bun-1.5"]) {
      expect(isNodelessBunRuntime(runtime)).toBe(true);
    }
    for (const runtime of ["bun", "bun-legacy", "node", "node-24", undefined]) {
      expect(isNodelessBunRuntime(runtime)).toBe(false);
    }
  });

  it.each(["node-24", "node-26"] as const)(
    "accepts internal runtime %s in both public and internal schemas",
    (runtime) => {
      expect(ConfigRuntime.safeParse(runtime).success).toBe(true);
      expect(BuildRuntime.safeParse(runtime).success).toBe(true);
      expect(resolveBuildRuntime(runtime)).toBe(runtime);
    }
  );

  it("rejects unsupported config runtimes with a clear error", () => {
    expect(() => resolveBuildRuntime("node-23")).toThrowError(
      /Unsupported runtime "node-23" in trigger\.config\. Supported runtimes:/
    );
  });

  it.each(["experimental-node-24", "experimental-node-26"] as const)(
    "treats %s as a deprecated alias kept out of internal runtime schemas",
    (runtime) => {
      expect(BuildRuntime.safeParse(runtime).success).toBe(false);
      expect(BuildManifest.shape.runtime.safeParse(runtime).success).toBe(false);
      expect(WorkerManifest.shape.runtime.safeParse(runtime).success).toBe(false);
      expect(isDeprecatedConfigRuntime(runtime)).toBe(true);
    }
  );
});
