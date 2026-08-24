import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Log mode: mint + verify + metrics, but the platform must NOT be scoped, so no environment_id is
// forwarded even for a valid token. (vi.mock is hoisted; secret literal here, mirrored below.)
vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: "integration-test-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "log",
  },
}));

const SECRET = "integration-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);

const { WorkloadServer } = await import("./index.js");

const PORT = 18733;
const BASE = `http://127.0.0.1:${PORT}`;

const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_should_not_forward",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};

const calls: { getSnapshotsSince: any[][] } = { getSnapshotsSince: [] };

const workerClient = {
  getSnapshotsSince: vi.fn(async (...args: any[]) => {
    calls.getSnapshotsSince.push(args);
    return { success: true as const, data: { snapshots: [] } };
  }),
} as any;

let server: InstanceType<typeof WorkloadServer>;

beforeAll(async () => {
  server = new WorkloadServer({
    port: PORT,
    workerClient,
    snapshotCallbackSecret: "snapshot-callback-secret",
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe("WorkloadServer auth (log mode)", () => {
  it("allows a valid token but forwards no environment_id", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    const res = await fetch(`${BASE}/api/v1/workload-actions/runs/run_1/snapshots/since/snap_1`, {
      headers: {
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
      },
    });

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBeUndefined();
  });

  it("does not reject an invalid token in log mode", async () => {
    const badToken = await mintWorkloadDeploymentToken(claims, "wrong-secret", EXP);
    const res = await fetch(`${BASE}/api/v1/workload-actions/runs/run_1/snapshots/since/snap_1`, {
      headers: {
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: badToken,
      },
    });

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBeUndefined();
  });
});
