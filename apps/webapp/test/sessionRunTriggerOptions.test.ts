import { describe, expect, it } from "vitest";
import { buildSessionRunOptions } from "~/services/realtime/sessionRunManager.server";

const baseConfig = { basePayload: {} };

describe("buildSessionRunOptions", () => {
  it("forwards the session's external deployment id", () => {
    const options = buildSessionRunOptions({ ...baseConfig, externalDeploymentId: "commit-abc" });

    expect(options.externalDeploymentId).toBe("commit-abc");
  });

  it("forwards both pins so the trigger path can apply precedence", () => {
    const options = buildSessionRunOptions({
      ...baseConfig,
      lockToVersion: "20260807.1",
      externalDeploymentId: "commit-abc",
    });

    expect(options.lockToVersion).toBe("20260807.1");
    expect(options.externalDeploymentId).toBe("commit-abc");
  });

  it("omits the id when the session has no pin", () => {
    expect(buildSessionRunOptions(baseConfig)).not.toHaveProperty("externalDeploymentId");
  });

  it("still maps the rest of the config", () => {
    const options = buildSessionRunOptions({
      ...baseConfig,
      machine: "small-1x",
      queue: "my-queue",
      tags: ["chat:abc"],
      maxAttempts: 3,
      maxDuration: 600,
      region: "us-east-1",
      externalDeploymentId: "commit-abc",
    });

    expect(options).toMatchObject({
      machine: "small-1x",
      queue: { name: "my-queue" },
      tags: ["chat:abc"],
      maxAttempts: 3,
      maxDuration: 600,
      region: "us-east-1",
      externalDeploymentId: "commit-abc",
    });
  });
});
