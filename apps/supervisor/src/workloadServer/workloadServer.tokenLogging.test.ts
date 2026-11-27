import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { io } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "token-logging-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);
const claims = {
  deployment: "deployment_test",
  deployment_version: "20260710.1",
  environment_id: "env_1",
  environment_type: "PRODUCTION",
  org_id: "org_1",
  project_id: "proj_1",
};
const message = (friendlyId: string) => ({
  version: "1" as const,
  run: { friendlyId },
  snapshot: { friendlyId: "snapshot_1" },
});

const originalEnv = { ...process.env };
let Logger: typeof SimpleStructuredLogger | undefined;
const stdoutWrite = process.stdout.write;

afterEach(() => {
  process.stdout.write = stdoutWrite;
  if (Logger) Logger.onLog = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

type Captured = { logs: Record<string, unknown>[]; wideEvents: Record<string, unknown>[] };

async function runSocketLifecycle(
  enforcement: "disabled" | "log" | "enforce",
  port: number,
  deploymentIdHeader: string
): Promise<Captured> {
  Object.assign(process.env, {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: SECRET,
    WORKLOAD_TOKEN_ENFORCEMENT: enforcement,
    DEBUG: "1",
    VERBOSE: "1",
  });
  vi.resetModules();
  const { WorkloadServer } = await import("./index.js");
  ({ SimpleStructuredLogger: Logger } =
    await import("@trigger.dev/core/v3/utils/structuredLogger"));

  const captured: Captured = { logs: [], wideEvents: [] };
  Logger.onLog = (line) => {
    captured.logs.push(line);
  };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    for (const line of String(chunk).split("\n")) {
      if (line.includes('"msg":"wide_event"')) captured.wideEvents.push(JSON.parse(line));
    }
    return (stdoutWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;

  const server = new WorkloadServer({
    port,
    host: "127.0.0.1",
    workerClient: {} as any,
    wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: true },
    wideEventsNoisyRoutes: false,
  });
  await server.start();

  const client = io(`http://127.0.0.1:${port}/workload`, {
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: {
      [WORKLOAD_HEADERS.DEPLOYMENT_ID]: deploymentIdHeader,
      [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    const bound = new Promise<void>((resolve) => server.once("runConnected", () => resolve()));
    client.emit("run:start", message("run_1"));
    await bound;
    const unbound = new Promise<void>((resolve) => server.once("runDisconnected", () => resolve()));
    client.emit("run:stop", message("run_1"));
    await unbound;
  } finally {
    client.close();
    await server.stop();
  }
  return captured;
}

function socketLines(logs: Record<string, unknown>[]) {
  return logs.filter((line) => line.$name === "workload-server" && "socketId" in line);
}

function runWideEvents(wideEvents: Record<string, unknown>[]) {
  return wideEvents.filter((event) => String(event.op).startsWith("socket.run."));
}

describe("WorkloadServer socket logs", () => {
  it.each([
    ["a valid token in log mode", "log", 18791, SECRET],
    ["a valid token in enforce mode", "enforce", 18792, SECRET],
    ["an invalid token in log mode", "log", 18793, "wrong-secret"],
    ["a token with verification disabled", "disabled", 18794, SECRET],
  ] as const)("never logs %s", async (_name, enforcement, port, signingSecret) => {
    const token = await mintWorkloadDeploymentToken(claims, signingSecret, EXP);
    const signature = token.split(".")[2]!;

    const { logs, wideEvents } = await runSocketLifecycle(enforcement, port, token);

    const lifecycle = socketLines(logs);
    expect(lifecycle.map((line) => line.message)).toEqual(
      expect.arrayContaining(["wsServer socket connected", "runConnected", "runDisconnected"])
    );
    for (const line of lifecycle) expect(line).not.toHaveProperty("socketData");
    expect(runWideEvents(wideEvents).map((event) => event.op)).toEqual([
      "socket.run.connected",
      "socket.run.disconnected",
    ]);
    for (const line of [...logs, ...wideEvents])
      expect(JSON.stringify(line)).not.toContain(signature);
  });

  it("leaves the deployment id out of wide events when the token is not verified", async () => {
    const token = await mintWorkloadDeploymentToken(claims, "wrong-secret", EXP);

    const { wideEvents } = await runSocketLifecycle("log", 18795, token);

    const events = runWideEvents(wideEvents);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).not.toHaveProperty(["meta.deployment_id"]);
  });

  it("logs the verified deployment friendly id", async () => {
    const token = await mintWorkloadDeploymentToken(claims, SECRET, EXP);

    const { logs, wideEvents } = await runSocketLifecycle("log", 18796, token);

    const connected = socketLines(logs).find((line) => line.message === "runConnected");
    expect(connected?.deploymentId).toBe("deployment_test");
    expect(runWideEvents(wideEvents).map((event) => event["meta.deployment_id"])).toEqual([
      "deployment_test",
      "deployment_test",
    ]);
  });

  it("logs a legacy bare deployment id as is", async () => {
    const { logs, wideEvents } = await runSocketLifecycle("disabled", 18797, "deployment_legacy");

    const connected = socketLines(logs).find((line) => line.message === "runConnected");
    expect(connected?.deploymentId).toBe("deployment_legacy");
    expect(runWideEvents(wideEvents).map((event) => event["meta.deployment_id"])).toEqual([
      "deployment_legacy",
      "deployment_legacy",
    ]);
  });
});
