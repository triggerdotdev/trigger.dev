import { describe, it, expect } from "vitest";
import { nodeOptionsWithMaxOldSpaceSize } from "./index.js";
import { MachinePreset } from "../schemas/common.js";

describe("nodeOptionsWithMaxOldSpaceSize", () => {
  const testMachine: MachinePreset = {
    name: "small-2x",
    memory: 1, // 1GB = 1024 MiB
    cpu: 1,
    centsPerMs: 0,
  };

  // With default 0.2 overhead, max-old-space-size should be 819 (1024 * 0.8)
  const expectedFlag = "--max-old-space-size=819";

  it("handles undefined NODE_OPTIONS", () => {
    const result = nodeOptionsWithMaxOldSpaceSize(undefined, testMachine);
    expect(result).toBe(expectedFlag);
  });

  it("handles empty string NODE_OPTIONS", () => {
    const result = nodeOptionsWithMaxOldSpaceSize("", testMachine);
    expect(result).toBe(expectedFlag);
  });

  it("preserves existing flags while adding max-old-space-size", () => {
    const result = nodeOptionsWithMaxOldSpaceSize("--inspect --trace-warnings", testMachine);
    expect(result).toBe(`--inspect --trace-warnings ${expectedFlag}`);
  });

  it("replaces existing max-old-space-size flag", () => {
    const result = nodeOptionsWithMaxOldSpaceSize(
      "--max-old-space-size=4096 --inspect",
      testMachine
    );
    expect(result).toBe(`--inspect ${expectedFlag}`);
  });

  it("handles multiple existing max-old-space-size flags", () => {
    const result = nodeOptionsWithMaxOldSpaceSize(
      "--max-old-space-size=4096 --inspect --max-old-space-size=8192",
      testMachine
    );
    expect(result).toBe(`--inspect ${expectedFlag}`);
  });

  it("handles extra spaces between flags", () => {
    const result = nodeOptionsWithMaxOldSpaceSize("--inspect    --trace-warnings", testMachine);
    expect(result).toBe(`--inspect --trace-warnings ${expectedFlag}`);
  });

  it("uses custom overhead value", () => {
    const result = nodeOptionsWithMaxOldSpaceSize("--inspect", testMachine, 0.5);
    // With 0.5 overhead, max-old-space-size should be 512 (1024 * 0.5)
    expect(result).toBe("--inspect --max-old-space-size=512");
  });
});
