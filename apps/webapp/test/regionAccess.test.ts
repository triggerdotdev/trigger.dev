import { describe, expect, it } from "vitest";
import { resolveEffectiveDefaultWorkerGroupId } from "~/v3/regionAccess.server";

describe("resolveEffectiveDefaultWorkerGroupId", () => {
  it("prefers the environment default", () => {
    expect(
      resolveEffectiveDefaultWorkerGroupId({
        environmentDefaultWorkerGroupId: "env",
        projectDefaultWorkerGroupId: "project",
        globalDefaultWorkerGroupId: "global",
      })
    ).toBe("env");
  });

  it("falls back to the project default when the environment has none", () => {
    expect(
      resolveEffectiveDefaultWorkerGroupId({
        environmentDefaultWorkerGroupId: null,
        projectDefaultWorkerGroupId: "project",
        globalDefaultWorkerGroupId: "global",
      })
    ).toBe("project");
  });

  it("falls back to the global default when env and project have none", () => {
    expect(
      resolveEffectiveDefaultWorkerGroupId({
        environmentDefaultWorkerGroupId: null,
        projectDefaultWorkerGroupId: null,
        globalDefaultWorkerGroupId: "global",
      })
    ).toBe("global");
  });

  it("returns undefined when nothing is set", () => {
    expect(
      resolveEffectiveDefaultWorkerGroupId({
        environmentDefaultWorkerGroupId: null,
        projectDefaultWorkerGroupId: null,
        globalDefaultWorkerGroupId: null,
      })
    ).toBeUndefined();
  });
});
