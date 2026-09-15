import { describe, expect, it } from "vitest";
import { resolveDeploymentRuntime } from "./runtime.js";

describe("resolveDeploymentRuntime", () => {
  it("uses the project default when runtime is omitted", () => {
    expect(
      resolveDeploymentRuntime({
        configuredRuntime: "node",
        runtimeWasExplicit: false,
        projectDefaultRuntime: "node-24",
      })
    ).toBe("node-24");
  });

  it("keeps an explicit runtime", () => {
    expect(
      resolveDeploymentRuntime({
        configuredRuntime: "node",
        runtimeWasExplicit: true,
        projectDefaultRuntime: "node-24",
      })
    ).toBe("node");
  });
});
