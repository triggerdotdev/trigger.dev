import { describe, expect, it } from "vitest";
import { checkEsbuildVersion, SUPPORTED_ESBUILD_RANGE } from "./esbuildVersion.js";

describe("checkEsbuildVersion", () => {
  it("accepts a version inside the declared range", () => {
    expect(checkEsbuildVersion("0.23.0")).toBeUndefined();
    expect(checkEsbuildVersion("0.23.9")).toBeUndefined();
  });

  it("rejects 0.25.0, which emits sourcemaps with dangling source indices", () => {
    // The out-of-bounds source-index regression makes source-map-support throw
    // `No element indexed by N` inside recordSpanException at runtime, long
    // after the build reported success.
    const issue = checkEsbuildVersion("0.25.0");

    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("0.25.1");
    expect(issue?.message).toContain("overrides");
  });

  it("does not reject the release that fixed the regression", () => {
    const issue = checkEsbuildVersion("0.25.1");

    expect(issue?.level).not.toBe("error");
  });

  it("warns, but does not fail, for an out-of-range version that is not known bad", () => {
    const issue = checkEsbuildVersion("0.24.2");

    expect(issue?.level).toBe("warning");
    expect(issue?.message).toContain(SUPPORTED_ESBUILD_RANGE);
  });

  it("ignores a version it cannot parse", () => {
    expect(checkEsbuildVersion("not-a-version")).toBeUndefined();
  });
});
