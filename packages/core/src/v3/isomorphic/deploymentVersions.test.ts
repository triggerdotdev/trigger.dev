import { describe, expect, it } from "vitest";
import { compareDeploymentVersions } from "./deploymentVersions.js";

describe("compareDeploymentVersions", () => {
  it("orders by date, then by number", () => {
    expect(compareDeploymentVersions("20261123.6", "20261124.1")).toBe(-1);
    expect(compareDeploymentVersions("20261123.10", "20261123.9")).toBe(1);
    expect(compareDeploymentVersions("20261123.6", "20261123.6")).toBe(0);
  });

  // Catches: the threshold accepting `\d+(\.\d+)*` while the comparison read two segments, so
  // `20261123.6.1` compared equal to `20261123.6` and a run on .6 was never below it.
  it("compares every segment of a longer version", () => {
    expect(compareDeploymentVersions("20261123.6", "20261123.6.1")).toBe(-1);
    expect(compareDeploymentVersions("20261123.6.2", "20261123.6.10")).toBe(-1);
    expect(compareDeploymentVersions("20261123.6.0", "20261123.6")).toBe(0);
  });

  // Catches: a one-segment version comparing equal to every version on that date (NaN number).
  it("counts a missing segment as 0", () => {
    expect(compareDeploymentVersions("20261123", "20261123.1")).toBe(-1);
    expect(compareDeploymentVersions("7", "10")).toBe(-1);
  });

  it("compares a segment that isn't a number as text", () => {
    expect(compareDeploymentVersions("dev.a", "dev.b")).toBe(-1);
    expect(compareDeploymentVersions("dev.a", "dev.a")).toBe(0);
  });
});
