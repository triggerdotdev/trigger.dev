import { describe, it, expect } from "vitest";
import {
  execPathForRuntime,
  execOptionsForRuntime,
} from "@trigger.dev/core/v3/build";

describe("Python Runtime", () => {
  it("returns python3 binary path", () => {
    const pythonPath = execPathForRuntime("python");
    expect(pythonPath).toBe("python3");
  });

  it("provides Python exec options with unbuffered flag", () => {
    const options = execOptionsForRuntime("python", {});
    expect(options).toBe("-u");
  });
});
