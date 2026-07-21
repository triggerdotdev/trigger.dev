import { describe, expect, it } from "vitest";
import { BuildManifest, BuildRuntime, ConfigRuntime, WorkerManifest } from "../schemas/build.js";
import { isExperimentalConfigRuntime, resolveBuildRuntime } from "./runtime.js";

describe("runtime configuration", () => {
  it.each(["node", "node-22", "experimental-node-24", "experimental-node-26", "bun"] as const)(
    "accepts %s as a public config runtime",
    (runtime) => {
      expect(ConfigRuntime.parse(runtime)).toBe(runtime);
    }
  );

  it.each([
    ["experimental-node-24", "node-24"],
    ["experimental-node-26", "node-26"],
    ["node", "node"],
    ["node-22", "node-22"],
    ["bun", "bun"],
  ] as const)("normalizes %s to %s", (runtime, expected) => {
    expect(resolveBuildRuntime(runtime)).toBe(expected);
  });

  it.each(["node-24", "node-26"] as const)(
    "keeps internal runtime %s out of the public config schema",
    (runtime) => {
      expect(ConfigRuntime.safeParse(runtime).success).toBe(false);
      expect(BuildRuntime.safeParse(runtime).success).toBe(true);
      expect(() => resolveBuildRuntime(runtime)).toThrowError(/Unsupported runtime/);
    }
  );

  it("rejects unsupported config runtimes with a clear error", () => {
    expect(() => resolveBuildRuntime("node-23")).toThrowError(
      /Unsupported runtime "node-23" in trigger\.config\. Supported runtimes:/
    );
  });

  it.each(["experimental-node-24", "experimental-node-26"] as const)(
    "keeps %s out of internal runtime schemas",
    (runtime) => {
      expect(BuildRuntime.safeParse(runtime).success).toBe(false);
      expect(BuildManifest.shape.runtime.safeParse(runtime).success).toBe(false);
      expect(WorkerManifest.shape.runtime.safeParse(runtime).success).toBe(false);
      expect(isExperimentalConfigRuntime(runtime)).toBe(true);
    }
  );
});
