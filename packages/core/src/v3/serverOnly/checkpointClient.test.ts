import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { CheckpointClient } from "./checkpointClient.js";
import { SupervisorHttpClient } from "../runEngineWorker/supervisor/http.js";
import { WORKER_HEADERS } from "../runEngineWorker/consts.js";

// Catches: dropping the authentication that lets iceman trust the caller's verified environment.
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
