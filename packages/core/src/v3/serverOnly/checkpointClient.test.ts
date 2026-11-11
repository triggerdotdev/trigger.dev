import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointClient, type SnapshotDeleteRetry } from "./checkpointClient.js";
import { SupervisorHttpClient } from "../runEngineWorker/supervisor/http.js";
import { WORKER_HEADERS } from "../runEngineWorker/consts.js";

// Catches: dropping the authentication that lets the receiver trust the caller's verified environment.
it("authenticates the legacy suspend hop and preserves its verified environment", async () => {
  let headers: IncomingHttpHeaders = {};
  let body: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    headers = request.headers;
    let raw = "";
    for await (const chunk of request) raw += chunk;
    body = JSON.parse(raw);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const client = new CheckpointClient({
      apiUrl,
      orchestrator: "DOCKER",
      managedWorkerSecret: "test-shared-secret",
      workerClient: new SupervisorHttpClient({
        apiUrl: apiUrl.href,
        workerToken: "test-token",
        instanceName: "test",
      }),
    });
    expect(
      await client.suspendRun({
        runFriendlyId: "run_1",
        snapshotFriendlyId: "snapshot_1",
        body: {
          runId: "run_1",
          snapshotId: "snapshot_1",
          runnerId: "runner_1",
          projectRef: "proj_1",
          deploymentVersion: "1",
          environmentId: "env_verified",
        },
      })
    ).toBe(true);
    expect(headers[WORKER_HEADERS.MANAGED_SECRET]).toBe("test-shared-secret");
    expect(body.environmentId).toBe("env_verified");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Catches: a snapshot delete going out without the secret the service requires before it deletes.
it("authenticates a snapshot delete and sends the run's tenancy by project ID", async () => {
  let headers: IncomingHttpHeaders = {};
  let path = "";
  let body: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    headers = request.headers;
    path = request.url ?? "";
    let raw = "";
    for await (const chunk of request) raw += chunk;
    body = JSON.parse(raw);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const client = new CheckpointClient({
      apiUrl,
      orchestrator: "KUBERNETES",
      managedWorkerSecret: "test-shared-secret",
      workerClient: new SupervisorHttpClient({
        apiUrl: apiUrl.href,
        workerToken: "test-token",
        instanceName: "test",
      }),
    });
    const tenancy = {
      orgId: "org_1",
      envId: "env_1",
      projectId: "clx8p0r7j0001qz8e4f2h1jkl",
      deploymentVersion: "20261105.3",
    };
    expect((await client.deleteSnapshots({ runFriendlyId: "run_1", body: tenancy })).outcome).toBe(
      "accepted"
    );
    expect(path).toBe("/api/v1/runs/run_1/snapshots/delete");
    expect(headers[WORKER_HEADERS.MANAGED_SECRET]).toBe("test-shared-secret");
    expect(body).toEqual(tenancy);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("CheckpointClient.deleteSnapshots retries", () => {
  // Each request takes the next scripted reply (a status, or "drop" for a reset connection); the
  // last one repeats.
  let script: Array<number | "drop"> = [];
  let requests = 0;
  let server: ReturnType<typeof createServer>;
  let apiUrl: URL;
  const tenancy = {
    orgId: "org_1",
    envId: "env_1",
    projectId: "clx8p0r7j0001qz8e4f2h1jkl",
    deploymentVersion: "20261105.3",
  };

  beforeEach(async () => {
    requests = 0;
    server = createServer(async (request, response) => {
      for await (const _ of request);
      const reply = script[Math.min(requests, script.length - 1)]!;
      requests++;
      if (reply === "drop") {
        response.socket?.destroy();
        return;
      }
      response.writeHead(reply, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: reply < 300 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (
    snapshotDeleteRetry: SnapshotDeleteRetry = {
      maxAttempts: 4,
      minDelayMs: 5,
      maxDelayMs: 20,
      budgetMs: 5_000,
    }
  ) =>
    new CheckpointClient({
      apiUrl,
      orchestrator: "KUBERNETES",
      managedWorkerSecret: "test-shared-secret",
      workerClient: new SupervisorHttpClient({
        apiUrl: apiUrl.href,
        workerToken: "test-token",
        instanceName: "test",
      }),
      snapshotDeleteRetry,
    }).deleteSnapshots({ runFriendlyId: "run_1", body: tenancy });

  // Catches: a delete lost because the service was restarting.
  it("retries a restarting service until it accepts", async () => {
    script = [503, "drop", 502, 202];
    expect(await call()).toEqual({ outcome: "accepted", attempts: 4, status: 202 });
    expect(requests).toBe(4);
  });

  it("retries a rate limit and a gateway timeout", async () => {
    script = [429, 504, 202];
    expect((await call()).outcome).toBe("accepted");
    expect(requests).toBe(3);
  });

  // Catches: an unbounded loop against a service that stays down.
  it("gives up after its attempts", async () => {
    script = [503];
    expect(await call()).toEqual({ outcome: "gave_up", attempts: 4, status: 503 });
    expect(requests).toBe(4);
  });

  it("gives up when the budget runs out before the attempts do", async () => {
    script = [503];
    const result = await call({ maxAttempts: 100, minDelayMs: 50, maxDelayMs: 50, budgetMs: 200 });
    expect(result.outcome).toBe("gave_up");
    expect(requests).toBeLessThan(10);
  });

  // Catches: hammering the service with a request it has already refused.
  it.each([401, 400])("never retries a %i", async (status) => {
    script = [status, 202];
    expect(await call()).toEqual({ outcome: "rejected", attempts: 1, status });
    expect(requests).toBe(1);
  });
});
