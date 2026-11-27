import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { ApiClient } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MANAGED_WORKER_SECRET, seedEngineFixtures } from "../../test/bench/lib/engineFixtures";

const RUNNER_ID = "runner-snapshots-since-e2e";

let server: TestServer;

beforeAll(async () => {
  // The engine worker moves runs from the master queue to the worker queue.
  server = await startTestServer({ overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" } });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

describe("snapshots since", () => {
  it("answers a since snapshot the run does not have with a 404", async () => {
    const fixtures = await seedEngineFixtures(server.prisma, { taskCount: 1 });
    const api = new ApiClient(server.webapp.baseUrl, fixtures.environmentApiKey);
    const supervisor = new SupervisorHttpClient({
      apiUrl: server.webapp.baseUrl,
      workerToken: fixtures.workerGroupToken,
      instanceName: "snapshots-since",
      managedWorkerSecret: MANAGED_WORKER_SECRET,
    });
    const { id: runId } = await api.triggerTask(fixtures.taskIdentifiers[0]!, { payload: {} });
    const dequeued = await vi.waitFor(
      async () => {
        const result = await supervisor.dequeue({});
        if (!result.success) throw new Error(result.error);
        if (!result.data[0]) throw new Error("Nothing dequeued yet");
        return result.data[0];
      },
      { timeout: 10_000, interval: 100 }
    );

    const known = await supervisor.getSnapshotsSince(
      runId,
      dequeued.snapshot.friendlyId,
      RUNNER_ID,
      fixtures.environmentId
    );
    expect(known.success).toBe(true);

    // Catches: an unknown since snapshot answered with a 500, which reads as a server failure.
    const unknown = await supervisor.getSnapshotsSince(
      runId,
      "snapshot_doesnotexist00000",
      RUNNER_ID,
      fixtures.environmentId
    );
    expect(unknown).toMatchObject({
      success: false,
      statusCode: 404,
      error: "Snapshot not found",
    });
  }, 60_000);
});
