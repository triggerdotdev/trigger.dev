import { describe, expect, it } from "vitest";
import { BuildManifest, BuildRuntime, ConfigRuntime, WorkerManifest } from "../schemas/build.js";
import {
  binaryForRuntime,
  execOptionsForRuntime,
  isBunRuntime,
  isDeprecatedConfigRuntime,
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
    "bun-1.3",
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
    ["bun-1.3", "bun-1.3"],
    ["bun-1.4", "bun-1.4"],
  ] as const)("normalizes %s to %s", (runtime, expected) => {
    expect(resolveBuildRuntime(runtime)).toBe(expected);
  });

  it.each(["bun", "bun-1.3", "bun-1.4"] as const)(
    "accepts %s in the internal schemas and runs it with the bun binary",
    (runtime) => {
      expect(BuildRuntime.safeParse(runtime).success).toBe(true);
      expect(BuildManifest.shape.runtime.safeParse(runtime).success).toBe(true);
      expect(WorkerManifest.shape.runtime.safeParse(runtime).success).toBe(true);
      expect(binaryForRuntime(runtime)).toBe("bun");
      expect(execOptionsForRuntime(runtime, {})).toBe("");
      expect(isBunRuntime(runtime)).toBe(true);
    }
  );

  it.each(["node", "node-24", undefined, null, ""])(
    "does not treat %s as a bun runtime",
    (runtime) => {
      expect(isBunRuntime(runtime)).toBe(false);
    }
  );

  it.each(["bun-1.2", "bun-1.5", "bun-2", "bun-latest"])(
    "rejects unsupported bun version %s",
    (runtime) => {
      expect(ConfigRuntime.safeParse(runtime).success).toBe(false);
      expect(BuildRuntime.safeParse(runtime).success).toBe(false);
      expect(() => resolveBuildRuntime(runtime)).toThrowError(
        new RegExp(
          `Unsupported runtime "${runtime}" in trigger\\.config\\. Supported runtimes:.*bun-1\\.4`
        )
      );
    }
  );

  it("normalizes an omitted runtime to node-24", () => {
    expect(resolveBuildRuntime(undefined)).toBe("node-24");
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
