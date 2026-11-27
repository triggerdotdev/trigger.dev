import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import {
  SupervisorHttpClient,
  WORKER_HEADERS,
  WORKLOAD_HEADERS,
} from "@trigger.dev/core/v3/workers";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkloadServer } from "./index.js";

const SECRET = "workload-token-forward-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_forward",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};

describe.each([
  ["disabled", 18761],
  ["log", 18762],
  ["enforce", 18763],
] as const)("workload token forwarding in %s mode", (mode, port) => {
  const base = `http://127.0.0.1:${port}/api/v1/workload-actions/runs`;
  let server: WorkloadServer;
  let platform: Server;
  let platformUrl: string;
  const received: { url?: string; headers: IncomingHttpHeaders }[] = [];
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      TRIGGER_API_URL: "http://localhost:3030",
      TRIGGER_WORKER_TOKEN: "test-token",
      MANAGED_WORKER_SECRET: "test-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      WORKLOAD_TOKEN_SECRET: SECRET,
      WORKLOAD_TOKEN_ENFORCEMENT: mode,
    });
    vi.resetModules();
    const { WorkloadServer } = await import("./index.js");
    platform = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        received.push({ url: req.url, headers: req.headers });
        res.writeHead(200, { "content-type": "application/json", "x-should-retry": "false" });
        res.end(JSON.stringify({ snapshots: [] }));
      });
    });
    await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
    platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
    server = new WorkloadServer({
      port,
      host: "127.0.0.1",
      workerClient: new SupervisorHttpClient({
        apiUrl: platformUrl,
        workerToken: "test-token",
        instanceName: "forward-test",
      }),
      wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
      wideEventsNoisyRoutes: false,
    });
    await server.start();
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    await server?.stop();
    if (platform) await new Promise<void>((resolve) => platform.close(() => resolve()));
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  async function request(path: string, deploymentId: string, body?: unknown) {
    return fetch(`${base}/run_forward/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: deploymentId,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_forward",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const proxied: [string, unknown?][] = [
    ["snapshots/since/snapshot_1"],
    ["snapshots/snapshot_1/heartbeat", {}],
    ["snapshots/snapshot_1/continue"],
  ];

  it("forwards the runner's token on proxied calls", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);
    for (const [path, body] of proxied) {
      await request(path, token, body);
      expect(received.at(-1)?.url, path).toContain(path.split("/").at(-1));
      expect(received.at(-1)?.headers[WORKER_HEADERS.WORKLOAD_TOKEN], path).toBe(token);
    }
    expect(received).toHaveLength(proxied.length);
  });

  it("does not forward a legacy bare deployment id", async () => {
    for (const [path, body] of proxied) {
      await request(path, "deployment_legacy", body);
    }
    expect(received).toHaveLength(proxied.length);
    for (const call of received) {
      expect(call.headers[WORKER_HEADERS.WORKLOAD_TOKEN]).toBeUndefined();
    }
  });

  it("sends no token on calls made without a runner token", async () => {
    const client = new SupervisorHttpClient({
      apiUrl: platformUrl,
      workerToken: "test-token",
      instanceName: "forward-test",
    });
    await client.getLatestSnapshot("run_forward", "runner_forward", "env_forward");
    await client.getSnapshotsSince("run_forward", "snapshot_1", "runner_forward");
    expect(received).toHaveLength(2);
    for (const call of received) {
      expect(call.headers[WORKER_HEADERS.WORKLOAD_TOKEN]).toBeUndefined();
    }
  });
});
