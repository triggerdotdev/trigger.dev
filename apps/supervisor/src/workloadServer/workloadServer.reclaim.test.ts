import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mintWorkloadDeploymentToken } from "@trigger.dev/core/v3";
import { CheckpointClient } from "@trigger.dev/core/v3/serverOnly";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/runEngineWorker";
import { WORKLOAD_HEADERS } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("std-env", () => ({
  env: {
    TRIGGER_API_URL: "http://localhost:3030",
    TRIGGER_WORKER_TOKEN: "test-token",
    MANAGED_WORKER_SECRET: "test-secret",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    WORKLOAD_TOKEN_SECRET: "reclaim-test-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
    DELETE_CHECKPOINTS_ON_COMPLETION: "true",
    DELETE_SNAPSHOTS_ON_COMPLETION: "true",
    TRIGGER_SNAPSHOT_DELETE_URL: "http://127.0.0.1:1",
  },
}));

const SECRET = "reclaim-test-secret";
const EXP = Math.floor(Date.UTC(2032, 0, 1) / 1000);

const { WorkloadServer } = await import("./index.js");
const { register } = await import("../metrics.js");

async function snapshotDeletes(result: string) {
  const metric = await register.getSingleMetric("snapshot_delete_requests_total")?.get();
  return metric?.values.find((v) => v.labels.result === result)?.value ?? 0;
}

const CLAIMS = {
  deployment: "deployment_test",
  deployment_version: "20261105.3",
  environment_id: "cmenv123",
  environment_type: "PRODUCTION",
  org_id: "cmorg123",
  project_id: "clx8p0r7j0001qz8e4f2h1jkl",
};

let attemptStatus = "RUN_FINISHED";
const workerClient = {
  completeRunAttempt: vi.fn(async () => ({
    success: true as const,
    data: { result: { attemptStatus } },
  })),
} as any;

// A real checkpoint service stand-in: records each request the supervisor's client sends, and
// answers with the next scripted status (202 once the script runs out).
type Received = { path: string; headers: IncomingHttpHeaders; body: unknown };
const received: Received[] = [];
let replies: number[] = [];
const checkpointService = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  received.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(raw) });
  const status = replies.shift() ?? 202;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: status < 300 }));
});
let client: CheckpointClient;

const paths = () => received.map((r) => r.path);

const runnerSnapshotter = {
  snapshotsEnabled: true,
  snapshotDelayMs: 1_000,
  snapshotDispatchLimit: 1,
  validateSuspend: vi.fn(),
  requestSuspend: vi.fn(),
  awaitSuspend: vi.fn(),
  publishedSuspends: vi.fn(async () => []),
} as any;

const MICROVM_PORT = 18741;
const CONTAINER_PORT = 18742;
const wideEventOpts = { service: "supervisor", env: { nodeId: "test" }, enabled: false };

let microvm: InstanceType<typeof WorkloadServer>;
let container: InstanceType<typeof WorkloadServer>;

beforeAll(async () => {
  await new Promise<void>((resolve) => checkpointService.listen(0, "127.0.0.1", resolve));
  client = new CheckpointClient({
    apiUrl: new URL(`http://127.0.0.1:${(checkpointService.address() as AddressInfo).port}`),
    orchestrator: "KUBERNETES",
    managedWorkerSecret: "test-secret",
    workerClient,
    snapshotDeleteRetry: { maxAttempts: 3, minDelayMs: 5, maxDelayMs: 20, budgetMs: 5_000 },
  });
  microvm = new WorkloadServer({
    port: MICROVM_PORT,
    workerClient,
    checkpointClient: client,
    snapshotDeleteClient: client,
    runnerSnapshotter,
    wideEventOpts,
    wideEventsNoisyRoutes: false,
  });
  container = new WorkloadServer({
    port: CONTAINER_PORT,
    workerClient,
    checkpointClient: client,
    snapshotDeleteClient: client,
    wideEventOpts,
    wideEventsNoisyRoutes: false,
  });
  await microvm.start();
  await container.start();
});

afterAll(async () => {
  await microvm.stop();
  await container.stop();
  checkpointService.closeAllConnections();
  await new Promise<void>((resolve) => checkpointService.close(() => resolve()));
});

beforeEach(() => {
  attemptStatus = "RUN_FINISHED";
  received.length = 0;
  replies = [];
});

async function complete(port: number) {
  const token = await mintWorkloadDeploymentToken(CLAIMS, SECRET, EXP);
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/workload-actions/runs/run_jkl/snapshots/snap_1/attempts/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WORKLOAD_HEADERS.RUNNER_ID]: "runner_1",
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
        [WORKLOAD_HEADERS.PROJECT_REF]: "proj_ref123",
      },
      body: JSON.stringify({ completion: { ok: true, id: "run_jkl", outputType: "text/plain" } }),
    }
  );
  expect(res.status).toBe(200);
}

describe("reclaim at run completion", () => {
  it("asks for the run's suspend snapshots to be deleted on the microVM lane, by project ID", async () => {
    await complete(MICROVM_PORT);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.path).toBe("/api/v1/runs/run_jkl/snapshots/delete");
    expect(received[0]?.headers[WORKER_HEADERS.MANAGED_SECRET]).toBe("test-secret");
    expect(received[0]?.body).toEqual({
      orgId: "cmorg123",
      envId: "cmenv123",
      projectId: "clx8p0r7j0001qz8e4f2h1jkl",
      deploymentVersion: "20261105.3",
    });
  });

  it("leaves a run that has not finished alone", async () => {
    attemptStatus = "RETRY_QUEUED";
    await complete(MICROVM_PORT);

    // The reclaim runs after the reply; a second, finished completion orders after it.
    attemptStatus = "RUN_FINISHED";
    await complete(MICROVM_PORT);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(paths()).toEqual(["/api/v1/runs/run_jkl/snapshots/delete"]);
  });

  it("keeps the container lane on checkpoint deletes", async () => {
    await complete(CONTAINER_PORT);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.path).toBe("/api/v1/runs/run_jkl/checkpoints/delete");
    expect(received[0]?.body).toEqual({
      orgId: "cmorg123",
      envId: "cmenv123",
      deploymentVersion: "20261105.3",
      projectRef: "proj_ref123",
    });
  });

  // Catches: a delete lost while the service restarts.
  it("retries a restarting service and counts the delete as retried", async () => {
    replies = [503, 502];
    const before = await snapshotDeletes("retried");
    await complete(MICROVM_PORT);

    await vi.waitFor(async () => expect(await snapshotDeletes("retried")).toBe(before + 1));
    expect(received).toHaveLength(3);
  });

  it("gives up after its attempts and counts it", async () => {
    replies = [503, 503, 503];
    const before = await snapshotDeletes("gave_up");
    await complete(MICROVM_PORT);

    await vi.waitFor(async () => expect(await snapshotDeletes("gave_up")).toBe(before + 1));
    expect(received).toHaveLength(3);
  });

  // Catches: retrying a request the service refused for its credentials.
  it("does not retry a 401", async () => {
    replies = [401];
    const before = await snapshotDeletes("http_error");
    await complete(MICROVM_PORT);

    await vi.waitFor(async () => expect(await snapshotDeletes("http_error")).toBe(before + 1));
    expect(received).toHaveLength(1);
  });
});
