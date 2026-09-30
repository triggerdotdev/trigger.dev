import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: "snapshots-test-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
  },
}));

const SECRET = "snapshots-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const PORT = 18742;

const { WorkloadServer } = await import("./index.js");

let server: InstanceType<typeof WorkloadServer> | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(snapshotsEnabled: boolean) {
  const runnerSnapshotter = {
    snapshotsEnabled,
    snapshotDelayMs: 100,
    snapshotDispatchLimit: 1,
    requestSuspend: vi.fn(async () => ({ ok: true as const })),
    awaitSuspend: vi.fn(async () => ({ ok: true as const, location: "snap-1" })),
    publishedSuspends: vi.fn(async () => []),
    publishedSuspendOf: vi.fn(async () => undefined),
    markSuspendSubmitted: vi.fn(async () => {}),
  };
  const checkpointClient = { suspendRun: vi.fn(async () => true) };
  server = new WorkloadServer({
    port: PORT,
    workerClient: { submitSuspendCompletion: vi.fn(async () => ({ success: true })) } as any,
    checkpointClient: checkpointClient as any,
    runnerSnapshotter,
    snapshotCallbackSecret: "snapshot-callback-secret",
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
  });
  await server.start();
  return { runnerSnapshotter, checkpointClient };
}

async function suspend() {
  const token = await mintWorkloadDeploymentToken(
    {
      deployment: "deployment_1",
      deployment_version: "20260930.1",
      environment_id: "env_1",
      environment_type: "PRODUCTION",
      org_id: "org_1",
      project_id: "proj_1",
    },
    SECRET,
    EXP
  );
  return fetch(
    `http://127.0.0.1:${PORT}/api/v1/workload-actions/runs/run_1/snapshots/snap_1/suspend`,
    {
      headers: {
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner-run_1",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.DEPLOYMENT_VERSION]: "20260930.1",
        [WORKLOAD_HEADERS.PROJECT_REF]: "proj_ref",
      },
    }
  );
}

describe("WorkloadServer suspend with a runner snapshotter", () => {
  it("asks the Runner for the snapshot, owned by the caller's deployment", async () => {
    const { runnerSnapshotter, checkpointClient } = await start(true);

    expect((await suspend()).status).toBe(202);
    await vi.waitFor(() => expect(runnerSnapshotter.requestSuspend).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(runnerSnapshotter.requestSuspend).toHaveBeenCalledWith({
      runnerId: "runner-run_1",
      runFriendlyId: "run_1",
      snapshotFriendlyId: "snap_1",
      owner: { envId: "env_1", deploymentFriendlyId: "deployment_1" },
    });
    expect(checkpointClient.suspendRun).not.toHaveBeenCalled();
  });

  it("leaves suspends to the checkpoint client when its snapshots are off", async () => {
    const { runnerSnapshotter, checkpointClient } = await start(false);

    expect((await suspend()).status).toBe(202);
    await vi.waitFor(() => expect(checkpointClient.suspendRun).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(runnerSnapshotter.requestSuspend).not.toHaveBeenCalled();
  });
});
