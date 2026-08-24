import { describe, expect, it } from "vitest";
import { EndAndContinueSessionRequestBody, SessionTriggerConfig } from "./api.js";

const baseConfig = { basePayload: {} };

describe("SessionTriggerConfig.externalDeploymentId", () => {
  it("accepts an id alongside lockToVersion — the trigger path decides which governs", () => {
    const result = SessionTriggerConfig.safeParse({
      ...baseConfig,
      lockToVersion: "20260807.1",
      externalDeploymentId: "commit-abc",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lockToVersion).toBe("20260807.1");
      expect(result.data.externalDeploymentId).toBe("commit-abc");
    }
  });

  it("imposes no format", () => {
    for (const id of ["a1b2c3", "v1.2.3", "release/2026-08-07", "refs/heads/main", "1"]) {
      const result = SessionTriggerConfig.safeParse({ ...baseConfig, externalDeploymentId: id });
      expect(result.success, `expected ${id} to be accepted`).toBe(true);
    }
  });

  it("trims surrounding whitespace", () => {
    const result = SessionTriggerConfig.safeParse({
      ...baseConfig,
      externalDeploymentId: "  commit-abc  ",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBe("commit-abc");
  });

  it("treats null as the opt-out rather than a 400", () => {
    const result = SessionTriggerConfig.safeParse({ ...baseConfig, externalDeploymentId: null });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBeUndefined();
  });

  it.each(["", "   "])("treats %j as absent rather than a 400", (value) => {
    const result = SessionTriggerConfig.safeParse({ ...baseConfig, externalDeploymentId: value });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBeUndefined();
  });

  it("is optional", () => {
    const result = SessionTriggerConfig.safeParse(baseConfig);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBeUndefined();
  });

  it("accepts 128 characters and rejects 129", () => {
    expect(
      SessionTriggerConfig.safeParse({ ...baseConfig, externalDeploymentId: "a".repeat(128) })
        .success
    ).toBe(true);
    expect(
      SessionTriggerConfig.safeParse({ ...baseConfig, externalDeploymentId: "a".repeat(129) })
        .success
    ).toBe(false);
  });

  it("measures length after trimming", () => {
    const result = SessionTriggerConfig.safeParse({
      ...baseConfig,
      externalDeploymentId: `  ${"a".repeat(128)}  `,
    });

    expect(result.success).toBe(true);
  });
});

describe("EndAndContinueSessionRequestBody.externalDeploymentId", () => {
  it("normalizes an upgrade re-pin", () => {
    const result = EndAndContinueSessionRequestBody.safeParse({
      callingRunId: "run_123",
      reason: "upgrade",
      externalDeploymentId: "  commit-abc  ",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBe("commit-abc");
  });

  it("is optional — an upgrade without one clears the pin", () => {
    const result = EndAndContinueSessionRequestBody.safeParse({
      callingRunId: "run_123",
      reason: "upgrade",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalDeploymentId).toBeUndefined();
  });
});
