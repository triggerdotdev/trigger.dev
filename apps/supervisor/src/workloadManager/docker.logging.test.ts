import "./testEnvironment.js";
import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkloadManagerCreateOptions } from "./types.js";

Object.assign(process.env, {
  DOCKER_REGISTRY_USERNAME: "test",
  DOCKER_REGISTRY_PASSWORD: "test",
  DOCKER_REGISTRY_URL: "registry.example.com",
});

const { DockerWorkloadManager } = await import("./docker.js");

const originalEnv = { ...process.env };

afterEach(() => {
  SimpleStructuredLogger.onLog = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("DockerWorkloadManager logs", () => {
  it("never logs the deployment token or the raw create options", async () => {
    const token = await mintWorkloadDeploymentToken(
      {
        deployment: "deployment_1",
        deployment_version: "20261027.1",
        environment_id: "env_1",
        environment_type: "PRODUCTION",
        org_id: "org_1",
        project_id: "proj_1",
      },
      "docker-logging-test-secret",
      Math.floor(Date.UTC(2032, 0, 1) / 1000)
    );
    const logs: Record<string, unknown>[] = [];
    SimpleStructuredLogger.onLog = (line) => {
      logs.push(line);
    };
    Object.assign(process.env, { VERBOSE: "1", DOCKER_HOST: "tcp://127.0.0.1:1" });
    const manager = new DockerWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
    });

    await manager.create({
      image: "registry.example.com/task:1",
      machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
      version: "20261027.1",
      nextAttemptNumber: 1,
      dequeuedAt: new Date(),
      envId: "env_1",
      envType: "PRODUCTION",
      orgId: "org_1",
      projectId: "proj_1",
      deploymentFriendlyId: "deployment_1",
      deploymentVersion: "20261027.1",
      deploymentToken: token,
      runId: "run1",
      runFriendlyId: "run_1",
      snapshotId: "snapshot1",
      snapshotFriendlyId: "snapshot_1",
    } as WorkloadManagerCreateOptions);

    const created = logs.find((line) => line.message === "create()");
    const pullFailed = logs.find((line) => line.message === "Failed to pull image");
    expect(created).toMatchObject({ runId: "run_1", deploymentId: "deployment_1" });
    expect(pullFailed).toMatchObject({ runId: "run_1", deploymentId: "deployment_1" });
    for (const line of [created, pullFailed]) expect(line).not.toHaveProperty("opts");
    for (const line of logs) expect(JSON.stringify(line)).not.toContain(token.split(".")[2]!);
  });
});
