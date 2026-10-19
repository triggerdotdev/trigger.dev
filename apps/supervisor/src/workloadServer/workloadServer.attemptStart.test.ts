import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  },
}));

const { WorkloadServer } = await import("./index.js");

const PORT = 18734;
const BASE = `http://127.0.0.1:${PORT}`;

const startRunAttempt = vi.fn(async () => ({
  success: true as const,
  data: { envVars: {} },
}));

const workerClient = { startRunAttempt } as any;

let server: InstanceType<typeof WorkloadServer>;

beforeAll(async () => {
  server = new WorkloadServer({
    port: PORT,
    workerClient,
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
    workerStamp: { workerCell: "cell-a", workerLane: "microvm" },
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

function startAttempt(body: Record<string, unknown>) {
  return fetch(`${BASE}/api/v1/workload-actions/runs/run_1/snapshots/snap_1/attempts/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
    },
    body: JSON.stringify(body),
  });
}

describe("WorkloadServer attempt start", () => {
  it("forwards the runner body with the supervisor's cell and lane stamped on", async () => {
    const res = await startAttempt({ isWarmStart: true });

    expect(res.status).toBe(200);
    expect(startRunAttempt).toHaveBeenLastCalledWith(
      "run_1",
      "snap_1",
      { isWarmStart: true, workerCell: "cell-a", workerLane: "microvm" },
      "runner_1",
      undefined
    );
  });

  it("does not let the runner choose its own cell or lane", async () => {
    const res = await startAttempt({ workerCell: "spoofed", workerLane: "container" });

    expect(res.status).toBe(200);
    expect(startRunAttempt).toHaveBeenLastCalledWith(
      "run_1",
      "snap_1",
      { workerCell: "cell-a", workerLane: "microvm" },
      "runner_1",
      undefined
    );
  });
});
