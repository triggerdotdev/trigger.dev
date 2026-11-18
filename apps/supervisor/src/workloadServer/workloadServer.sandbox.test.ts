import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import {
  SupervisorHttpClient,
  WORKER_HEADERS,
  WORKLOAD_HEADERS,
} from "@trigger.dev/core/v3/workers";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { io } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkloadServer } from "./index.js";

const SECRET = "sandbox-workload-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_sandbox",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};
const scope = { execution_mode: "SANDBOX" as const, run: "run_own" };
const message = (friendlyId: string) => ({
  version: "1" as const,
  run: { friendlyId },
  snapshot: { friendlyId: "snapshot_1" },
});

describe.each(["log", "enforce"] as const)("sandbox authorization in %s mode", (mode) => {
  const port = mode === "log" ? 18745 : 18746;
  const base = `http://127.0.0.1:${port}/api/v1/workload-actions/runs`;
  let server: WorkloadServer;
  let platform: Server;
  const received: { url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      TRIGGER_API_URL: "http://localhost:3030",
      TRIGGER_WORKER_TOKEN: "test-token",
      MANAGED_WORKER_SECRET: "test-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      WORKLOAD_TOKEN_SECRET: SECRET,
      WORKLOAD_TOKEN_ENFORCEMENT: mode,
      SEND_RUN_DEBUG_LOGS: String(mode === "enforce"),
    });
    vi.resetModules();
    const { WorkloadServer } = await import("./index.js");
    platform = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-should-retry": "false",
        });
        res.end(JSON.stringify({ snapshots: [] }));
      });
    });
    await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
    server = new WorkloadServer({
      port,
      host: "127.0.0.1",
      workerClient: new SupervisorHttpClient({
        apiUrl: `http://127.0.0.1:${(platform.address() as AddressInfo).port}`,
        workerToken: "test-token",
        instanceName: "sandbox-test",
        sendRunDebugLogs: true,
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

  async function request(run: string, path: string, token: string, body?: unknown) {
    return fetch(`${base}/${run}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_sandbox",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Catches: a sandbox controller acting on another run through any HTTP action, including debug logs.
  it("refuses cross-run actions without relaying them", async () => {
    const token = await mintWorkloadDeploymentToken({ ...claims, ...scope }, SECRET, EXP);
    const actions: [string, unknown?][] = [
      [
        "snapshots/snapshot_1/attempts/complete",
        {
          completion: { ok: true, id: "run_other", outputType: "application/json" },
        },
      ],
      ["snapshots/snapshot_1/heartbeat", {}],
      ["snapshots/snapshot_1/suspend"],
      ["snapshots/snapshot_1/continue"],
      ["snapshots/since/snapshot_1"],
      ["snapshots/snapshot_1/attempts/start", { isWarmStart: true }],
      // Debug logs are only relayed, and so only authorized, when enabled.
      ...(mode === "enforce"
        ? [["logs/debug", { time: new Date().toISOString(), message: "test" }] as [string, unknown]]
        : []),
    ];
    for (const [path, body] of actions) {
      const response = await request("run_other", path, token, body);
      expect(response.status, path).toBe(401);
    }
    expect(received).toEqual([]);
  });

  // Catches: raw backslashes in a snapshot ID escaping the sandbox's run during URL normalization.
  it.each([
    "snapshots/..\\..\\run_other\\snapshots\\snapshot_x/attempts/complete",
    "snapshots/since/..\\..\\..\\run_other\\snapshots\\snapshot_x",
  ])("rejects path traversal without forwarding: %s", async (path) => {
    const token = await mintWorkloadDeploymentToken({ ...claims, ...scope }, SECRET, EXP);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/v1/workload-actions/runs/run_own/${path}`,
          method: path.endsWith("complete") ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end(
        path.endsWith("complete")
          ? JSON.stringify({
              completion: { ok: true, id: "run_own", outputType: "application/json" },
            })
          : undefined
      );
    });
    expect(status).toBe(400);
    expect(received).toEqual([]);
  });

  // Catches: scope checks either denying the owning run or restricting standard warm-start tokens.
  it("allows the sandbox's own run and leaves deployment-wide tokens unrestricted", async () => {
    for (const [input, run] of [
      [{ ...claims, ...scope }, "run_own"],
      [claims, "run_other"],
    ] as const) {
      const token = await mintWorkloadDeploymentToken(input, SECRET, EXP);
      const response = await request(run, "snapshots/since/snapshot_1", token);
      expect(response.status).toBe(200);
      expect(received.at(-1)?.headers["x-trigger-worker-environment-id"]).toBe(
        mode === "enforce" ? claims.environment_id : undefined
      );
    }
    expect(received).toHaveLength(2);
  });

  // Catches: the platform being unable to tell a sandbox's own start or refresh from a standard runner's.
  it("forwards the verified sandbox run only when enforcing", async () => {
    for (const [input, expected] of [
      [{ ...claims, ...scope }, mode === "enforce" ? "run_own" : undefined],
      [claims, undefined],
    ] as const) {
      const token = await mintWorkloadDeploymentToken(input, SECRET, EXP);
      await request("run_own", "snapshots/snapshot_1/heartbeat", token, {});
      expect(received.at(-1)?.headers[WORKER_HEADERS.SANDBOX_RUN_ID]).toBe(expected);
    }
  });

  // Catches: a signed sandbox token without a run claim becoming deployment-wide.
  it("refuses a sandbox token with no run claim", async () => {
    const token = await mintWorkloadDeploymentToken(
      {
        ...claims,
        execution_mode: "SANDBOX",
      },
      SECRET,
      EXP
    );
    expect((await request("run_other", "snapshots/since/snapshot_1", token)).status).toBe(401);
    expect(received).toEqual([]);
  });

  // Catches: a sandbox socket subscribing to another run or sending cross-run disconnect events.
  it("only binds and unbinds the sandbox's own run on websocket events", async () => {
    const token = await mintWorkloadDeploymentToken({ ...claims, ...scope }, SECRET, EXP);
    const client = io(`http://127.0.0.1:${port}/workload`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_sandbox",
      },
    });
    const connected: string[] = [];
    const disconnected: string[] = [];
    const onConnected = ({ run }: { run: { friendlyId: string } }) =>
      connected.push(run.friendlyId);
    const onDisconnected = ({ run }: { run: { friendlyId: string } }) =>
      disconnected.push(run.friendlyId);
    server.on("runConnected", onConnected);
    server.on("runDisconnected", onDisconnected);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("connect_error", reject);
      });
      const bound = new Promise<void>((resolve) => server.once("runConnected", () => resolve()));
      client.emit("run:start", message("run_other"));
      client.emit("run:start", message("run_own"));
      await bound;
      const unbound = new Promise<void>((resolve) =>
        server.once("runDisconnected", () => resolve())
      );
      client.emit("run:stop", message("run_other"));
      client.emit("run:stop", message("run_own"));
      await unbound;
      expect(connected).toEqual(["run_own"]);
      expect(disconnected).toEqual(["run_own"]);
    } finally {
      client.close();
      server.off("runConnected", onConnected);
      server.off("runDisconnected", onDisconnected);
    }
  });
});
