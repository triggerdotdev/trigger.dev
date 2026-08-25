import { describe, expect, it } from "vitest";
import { deriveBuildPath, deriveDeploymentDurations } from "~/v3/deploymentTelemetry";

describe("deriveBuildPath", () => {
  it("classifies fromBundle native builds as native_local_bundle", () => {
    expect(deriveBuildPath({ isNativeBuild: true, fromBundle: true })).toBe("native_local_bundle");
  });

  it("classifies native builds without fromBundle as native", () => {
    expect(deriveBuildPath({ isNativeBuild: true })).toBe("native");
    expect(deriveBuildPath({ isNativeBuild: true, fromBundle: false })).toBe("native");
  });

  it("classifies everything else as depot", () => {
    expect(deriveBuildPath(null)).toBe("depot");
    expect(deriveBuildPath(undefined)).toBe("depot");
    expect(deriveBuildPath({})).toBe("depot");
    expect(deriveBuildPath({ buildId: "depot-build-id" })).toBe("depot");
    expect(deriveBuildPath({ isNativeBuild: false })).toBe("depot");
    // fromBundle alone (skewed writer) must not count as native_local_bundle
    expect(deriveBuildPath({ fromBundle: true })).toBe("depot");
    expect(deriveBuildPath("garbage")).toBe("depot");
  });
});

describe("deriveDeploymentDurations", () => {
  const t = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000);

  it("derives all phases for the full build-server chain", () => {
    const durations = deriveDeploymentDurations(
      { createdAt: t(0), startedAt: t(10), installedAt: t(40), builtAt: t(100) },
      t(130)
    );

    expect(durations).toEqual({
      totalMs: 130_000,
      queueMs: 10_000,
      installMs: 30_000,
      buildingMs: 60_000,
      deployingMs: 30_000,
    });
  });

  it("omits install and measures building from startedAt when installedAt is missing (depot)", () => {
    const durations = deriveDeploymentDurations(
      { createdAt: t(0), startedAt: t(0), installedAt: null, builtAt: t(90) },
      t(120)
    );

    expect(durations).toEqual({
      totalMs: 120_000,
      queueMs: 0,
      installMs: undefined,
      buildingMs: 90_000,
      deployingMs: 30_000,
    });
  });

  it("omits phases whose boundaries are missing (failed before building)", () => {
    const durations = deriveDeploymentDurations(
      { createdAt: t(0), startedAt: t(5), installedAt: null, builtAt: null },
      t(20)
    );

    expect(durations).toEqual({
      totalMs: 20_000,
      queueMs: 5_000,
      installMs: undefined,
      buildingMs: undefined,
      deployingMs: undefined,
    });
  });

  it("never returns negative durations on clock skew", () => {
    const durations = deriveDeploymentDurations(
      { createdAt: t(10), startedAt: t(5), installedAt: null, builtAt: null },
      t(3)
    );

    expect(durations.totalMs).toBe(0);
    expect(durations.queueMs).toBeUndefined();
  });
});
