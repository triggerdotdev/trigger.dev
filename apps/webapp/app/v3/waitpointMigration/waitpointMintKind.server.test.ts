import { describe, expect, it, vi } from "vitest";
import { computeWaitpointMintKind } from "./waitpointMintKind.server";

const environment = { organizationId: "org_1", id: "env_1" };

describe("computeWaitpointMintKind", () => {
  it("returns legacy when the org has no override and the default is legacy", async () => {
    const kind = await computeWaitpointMintKind(environment, {
      globalDefault: "legacy",
      flag: async () => undefined,
    });

    expect(kind).toBe("legacy");
  });

  it("returns store when the org override is redis", async () => {
    const kind = await computeWaitpointMintKind(environment, {
      globalDefault: "legacy",
      flag: async () => "redis",
    });

    expect(kind).toBe("store");
  });

  it("lets an explicit org legacy override beat a redis global default", async () => {
    const kind = await computeWaitpointMintKind(environment, {
      globalDefault: "redis",
      flag: async () => "legacy",
    });

    expect(kind).toBe("legacy");
  });

  it("falls back to the global default when the org has no override", async () => {
    const kind = await computeWaitpointMintKind(environment, {
      globalDefault: "redis",
      flag: async () => undefined,
    });

    expect(kind).toBe("store");
  });

  it("fails safe to legacy when the flag read throws", async () => {
    const kind = await computeWaitpointMintKind(environment, {
      globalDefault: "redis",
      flag: async () => {
        throw new Error("replica down");
      },
    });

    expect(kind).toBe("legacy");
  });

  it("hands the pre-loaded org flags to the flag reader", async () => {
    const flag = vi.fn(async () => "redis" as const);

    await computeWaitpointMintKind(
      { ...environment, orgFeatureFlags: { waitpointSystem: "redis" } },
      { globalDefault: "legacy", flag }
    );

    expect(flag).toHaveBeenCalledWith("org_1", { waitpointSystem: "redis" });
  });
});
