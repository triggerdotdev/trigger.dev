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

const PORT = 18736;
const BASE = `http://127.0.0.1:${PORT}`;

const heartbeatRun = vi.fn(async () => ({
  success: true as const,
  data: { ok: true as const, runToken: "replacement-token" },
}));

let server: InstanceType<typeof WorkloadServer>;

beforeAll(async () => {
  server = new WorkloadServer({
    port: PORT,
    workerClient: { heartbeatRun } as any,
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe("WorkloadServer run heartbeat", () => {
  it("forwards the runner's run-token report and returns the replacement token", async () => {
    const runToken = {
      expiresAt: 1_800_000_000,
      trigger: "restore",
      installation: { result: "failure", reason: "ack_timeout", trigger: "heartbeat" },
    };

    const res = await fetch(
      `${BASE}/api/v1/workload-actions/runs/run_1/snapshots/snap_1/heartbeat`,
      {
        method: "POST",
        headers: { "content-type": "application/json", [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1" },
        body: JSON.stringify({ runToken }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runToken: "replacement-token" });
    expect(heartbeatRun).toHaveBeenLastCalledWith(
      "run_1",
      "snap_1",
      { runToken },
      "runner_1",
      undefined
    );
  });
});
