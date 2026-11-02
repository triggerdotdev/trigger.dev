import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { ApiClient } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MANAGED_WORKER_SECRET,
  seedEngineFixtures,
  workerHeaders,
  type EngineFixtures,
} from "../../test/bench/lib/engineFixtures";

const INSTANCE_NAME = "attempt-complete-e2e";

let server: TestServer;
let fixtures: EngineFixtures;
let api: ApiClient;
let supervisor: SupervisorHttpClient;

beforeAll(async () => {
  server = await startTestServer({ overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" } });
  fixtures = await seedEngineFixtures(server.prisma, { taskCount: 1 });
  api = new ApiClient(server.webapp.baseUrl, fixtures.environmentApiKey);
  supervisor = new SupervisorHttpClient({
    apiUrl: server.webapp.baseUrl,
    workerToken: fixtures.workerGroupToken,
    instanceName: INSTANCE_NAME,
    managedWorkerSecret: MANAGED_WORKER_SECRET,
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

describe("attempt completion replayed after it was applied", () => {
  it("refuses the replay with the latest snapshot and applies its metadata only once", async () => {
    const { runId, snapshotId } = await startAttempt();
    const completion = {
      ok: false,
      id: runId,
      error: { type: "BUILT_IN_ERROR", name: "UserError", message: "boom", stackTrace: "" },
      retry: { timestamp: Date.now(), delay: 0 },
      flushedMetadata: {
        data: JSON.stringify({ operations: [{ type: "increment", key: "count", value: 1 }] }),
        dataType: "application/json",
      },
    };

    const first = await completeAttempt(runId, snapshotId, completion);
    expect(first.status).toBe(200);
    expect(first.body.result.attemptStatus).toBe("RETRY_IMMEDIATELY");
    await vi.waitFor(async () => expect(await metadataCount(runId)).toBe(1), {
      timeout: 5_000,
      interval: 50,
    });

    const replay = await completeAttempt(runId, snapshotId, completion);
    await setTimeout(500);
    expect(await metadataCount(runId)).toBe(1);

    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({
      error: "Snapshot ID doesn't match the latest snapshot",
      code: "SNAPSHOT_CONFLICT",
      latestSnapshotId: first.body.result.snapshot.friendlyId,
    });
  }, 60_000);
});

async function startAttempt() {
  const { id: runId } = await api.triggerTask(fixtures.taskIdentifiers[0]!, {
    payload: {},
    options: { maxAttempts: 3 },
  });

  const dequeued = await vi.waitFor(
    async () => {
      const result = await supervisor.dequeue({});
      if (!result.success) throw new Error(result.error);
      const message = result.data.find((m) => m.run.friendlyId === runId);
      if (!message) throw new Error(`${runId} was not dequeued`);
      return message;
    },
    { timeout: 10_000, interval: 100 }
  );

  const started = await supervisor.startRunAttempt(runId, dequeued.snapshot.friendlyId, {});
  if (!started.success) throw new Error(started.error);

  return { runId, snapshotId: started.data.snapshot.friendlyId };
}

async function completeAttempt(runId: string, snapshotId: string, completion: unknown) {
  const response = await server.webapp.fetch(
    `/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
    {
      method: "POST",
      headers: workerHeaders(fixtures, INSTANCE_NAME),
      body: JSON.stringify({ completion }),
    }
  );

  return { status: response.status, body: await response.json() };
}

async function metadataCount(runId: string) {
  const { metadata } = await server.prisma.taskRun.findFirstOrThrow({
    where: { friendlyId: runId },
    select: { metadata: true },
  });
  return metadata ? JSON.parse(metadata).count : undefined;
}
