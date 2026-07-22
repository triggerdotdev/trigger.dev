import { describe, expect, it } from "vitest";
import { BuildManifest, BuildRuntime, ConfigRuntime, WorkerManifest } from "../schemas/build.js";
import { isDeprecatedConfigRuntime, resolveBuildRuntime } from "./runtime.js";

describe("runtime configuration", () => {
  it.each([
    "node",
    "node-22",
    "node-24",
    "node-26",
    "experimental-node-24",
    "experimental-node-26",
    "bun",
  ] as const)("accepts %s as a public config runtime", (runtime) => {
    expect(ConfigRuntime.parse(runtime)).toBe(runtime);
  });

  it.each([
    ["experimental-node-24", "node-24"],
    ["experimental-node-26", "node-26"],
    ["node", "node"],
    ["node-22", "node-22"],
    ["node-24", "node-24"],
    ["node-26", "node-26"],
    ["bun", "bun"],
  ] as const)("normalizes %s to %s", (runtime, expected) => {
    expect(resolveBuildRuntime(runtime)).toBe(expected);
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
