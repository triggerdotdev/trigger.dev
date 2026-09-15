import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Set enforce mode + secret before env.ts parses (vi.mock is hoisted above imports, so the secret
// must be a literal here). SECRET below mirrors it for use in the test body.
vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: "integration-test-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
  },
}));

const SECRET = "integration-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);

const { WorkloadServer } = await import("./index.js");

const PORT = 18732;
const BASE = `http://127.0.0.1:${PORT}`;

function claims(environmentId = "env_test_123") {
  return {
    deployment: "deployment_test",
    deployment_version: "20260710.1",
    environment_id: environmentId,
    environment_type: "PRODUCTION",
    org_id: "org_1",
    project_id: "proj_1",
  };
}

// Records the args each relay method is called with so we can assert the forwarded claim.
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

function snapshotsSince(deploymentIdHeader?: string) {
  const headers: Record<string, string> = {
    [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
  };
  if (deploymentIdHeader !== undefined) {
    headers[WORKLOAD_HEADERS.DEPLOYMENT_ID] = deploymentIdHeader;
  }
  return fetch(`${BASE}/api/v1/workload-actions/runs/run_1/snapshots/since/snap_1`, { headers });
}

describe("WorkloadServer auth (enforce mode)", () => {
  it("allows a valid token and forwards the verified environment_id", async () => {
    const token = await mintWorkloadDeploymentToken(claims("env_forwarded_42"), SECRET, EXP);
    const res = await snapshotsSince(token);

    expect(res.status).toBe(200);
    const lastCall = calls.getSnapshotsSince.at(-1)!;
    // getSnapshotsSince(runId, snapshotId, runnerId, environmentId)
    expect(lastCall[3]).toBe("env_forwarded_42");
  });

  it("rejects a token signed with the wrong secret (401) and does not relay", async () => {
    const before = calls.getSnapshotsSince.length;
    const badToken = await mintWorkloadDeploymentToken(claims(), "wrong-secret", EXP);
    const res = await snapshotsSince(badToken);

    expect(res.status).toBe(401);
    expect(calls.getSnapshotsSince.length).toBe(before);
  });

  it("allows a legacy bare friendlyId and forwards no environment_id", async () => {
    const res = await snapshotsSince("deployment_legacy_bare");

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBeUndefined();
  });

  it("allows an absent token and forwards no environment_id", async () => {
    const res = await snapshotsSince(undefined);

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBeUndefined();
  });
});
