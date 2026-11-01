import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: "integration-test-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
    WORKLOAD_TOKEN_SECRET_PREVIOUS: "previous-test-secret",
    WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF: "2026-06-01T00:00:00.000Z",
  },
}));

const PREVIOUS_SECRET = "previous-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const AFTER_CUTOFF_MS = Date.UTC(2026, 9, 1);

const { WorkloadServer } = await import("./index.js");
const { register } = await import("../metrics.js");

const PORT = 18734;
const BASE = `http://127.0.0.1:${PORT}`;

const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_prev_after",
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
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
    wideEventsNoisyRoutes: false,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

function runIdCreatedAt(ms: number) {
  const now = vi.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return `run_${generateRunOpsId("us-east-1")}`;
  } finally {
    now.mockRestore();
  }
}

describe("WorkloadServer previous-key cutoff (log mode)", () => {
  it("allows a previous-key token for a run created after the cutoff, recording the failure", async () => {
    const warn = vi.spyOn(console, "warn");
    const runId = runIdCreatedAt(AFTER_CUTOFF_MS);
    const token = await mintWorkloadDeploymentToken(claims, PREVIOUS_SECRET, EXP);

    const res = await fetch(
      `${BASE}/api/v1/workload-actions/runs/${runId}/snapshots/since/snap_1`,
      {
        headers: {
          [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
          [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        },
      }
    );

    expect(res.status).toBe(200);
    expect(calls.getSnapshotsSince.at(-1)![3]).toBe("env_prev_after");

    const metric = await register.getSingleMetric("workload_token_previous_cutoff_total")?.get();
    expect(
      metric?.values.find((v) => v.labels.result === "fail" && v.labels.mode === "log")?.value
    ).toBe(1);

    const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain(runId);
    expect(logged).toContain("previous");
    expect(logged).toContain("fail");
    expect(logged).toContain(
      `"route":"GET /api/v1/workload-actions/runs/${runId}/snapshots/since/snap_1"`
    );
    expect(logged).toContain('"runnerId":"runner_1"');
    expect(logged).toContain('"deployment":"deployment_test"');
    expect(logged).toContain('"environmentId":"env_prev_after"');
    expect(logged).toContain('"orgId":"org_1"');
    expect(logged).toContain('"projectId":"proj_1"');
    expect(logged).toMatch(/"remoteAddress":"[^"]+"/);
    expect(logged).toMatch(/"remotePort":\d+/);
    expect(logged).toMatch(/"userAgent":"[^"]+"/);
    expect(logged).toMatch(/"exp":\d+/);
    warn.mockRestore();
  });

  it("binds a post-cutoff run on run:start from a previous-key socket, recording the failure", async () => {
    const token = await mintWorkloadDeploymentToken(claims, PREVIOUS_SECRET, EXP);
    const client = io(`http://127.0.0.1:${PORT}/workload`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_ws",
      },
    });
    const warn = vi.spyOn(console, "warn");

    try {
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      const runId = runIdCreatedAt(AFTER_CUTOFF_MS);
      const bound = new Promise<string>((resolve) =>
        server.once("runConnected", ({ run }) => resolve(run.friendlyId))
      );
      client.emit("run:start", {
        version: "1",
        run: { friendlyId: runId },
        snapshot: { friendlyId: "snap_1" },
      });

      expect(await bound).toBe(runId);
      const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain(runId);
      expect(logged).toContain('"transport":"ws"');
      expect(logged).toContain('"route":"run:start"');
      expect(logged).toContain('"runnerId":"runner_ws"');
      expect(logged).toContain('"deployment":"deployment_test"');
      expect(logged).toContain('"environmentId":"env_prev_after"');
      expect(logged).toMatch(/"remoteAddress":"[^"]+"/);
    } finally {
      warn.mockRestore();
      client.close();
    }
  });
});
