import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { ApiClient } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MANAGED_WORKER_SECRET,
  seedEngineFixtures,
  type EngineFixtures,
} from "./bench/lib/engineFixtures";

let server: TestServer;
let fixtures: EngineFixtures;
let api: ApiClient;
let supervisor: SupervisorHttpClient;

beforeAll(async () => {
  // The engine worker moves a triggered run onto the worker queue the supervisor dequeues from.
  server = await startTestServer({ overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" } });
  fixtures = await seedEngineFixtures(server.prisma, { taskCount: 1 });
  api = new ApiClient(server.webapp.baseUrl, fixtures.environmentApiKey);
  supervisor = new SupervisorHttpClient({
    apiUrl: server.webapp.baseUrl,
    workerToken: fixtures.workerGroupToken,
    instanceName: "suspend-e2e",
    managedWorkerSecret: MANAGED_WORKER_SECRET,
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

describe("suspend completion", () => {
  // Catches: the suspend route storing an unparseable location or not reporting the discard.
  it("answers discarded and stores nothing for a location its restore side can't parse", async () => {
    const { runId, snapshotId } = await runWaitingOnToken();

    const result = ok(
      await supervisor.submitSuspendCompletion({
        runId,
        snapshotId,
        body: {
          success: true,
          checkpoint: { type: "COMPUTE", location: "foo://bar-123" },
        },
      })
    );

    expect(result).toEqual({ ok: true, discarded: { error: "Invalid checkpoint location" } });
    const { execution } = ok(await supervisor.getLatestSnapshot(runId));
    expect(execution.snapshot.friendlyId).toBe(snapshotId);
    expect(execution.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
    expect(
      await server.prisma.taskRunCheckpoint.count({
        where: { location: "foo://bar-123" },
      })
    ).toBe(0);
  }, 60_000);

  // Catches: a stale-snapshot discard answered as stored, so the caller can't tell it was dropped.
  it("answers discarded for a checkpoint on a snapshot that is no longer the latest", async () => {
    const { runId, snapshotId } = await runWaitingOnToken();
    const checkpoint = { type: "COMPUTE" as const, location: "node-a/snap-1" };

    expect(
      ok(
        await supervisor.submitSuspendCompletion({
          runId,
          snapshotId,
          body: { success: true, checkpoint },
        })
      )
    ).toEqual({ ok: true });
    expect(
      ok(
        await supervisor.submitSuspendCompletion({
          runId,
          snapshotId,
          body: { success: true, checkpoint },
        })
      )
    ).toEqual({ ok: true, discarded: { error: "Not the latest snapshot" } });
  }, 60_000);
});

describe("checkpoint digest", () => {
  // Catches: the digest stripped by a schema between the suspend request and the restore dequeue.
  it("hands the digest recorded at suspend back with the restore", async () => {
    const { runId, snapshotId, tokenId } = await runWaitingOnToken();
    const digest = `sha256:${"9f".repeat(32)}`;

    expect(
      ok(
        await supervisor.submitSuspendCompletion({
          runId,
          snapshotId,
          body: {
            success: true,
            checkpoint: {
              type: "KUBERNETES",
              location: "registry.example.com/ns/image:tag",
              digest,
            },
          },
        })
      )
    ).toEqual({ ok: true });

    await api.completeWaitpointToken(tokenId, {});
    const restored = await dequeue();

    expect(restored.checkpoint?.digest).toBe(digest);
  }, 60_000);
});

function dequeue() {
  return vi.waitFor(
    async () => {
      const [message] = ok(await supervisor.dequeue({}));
      if (!message) throw new Error("Nothing dequeued yet");
      return message;
    },
    { timeout: 10_000, interval: 100 }
  );
}

/** Starts a run and blocks it on a waitpoint token, so its latest snapshot can be checkpointed. */
async function runWaitingOnToken() {
  const { id: runId } = await api.triggerTask(fixtures.taskIdentifiers[0]!, { payload: {} });
  const dequeued = await dequeue();
  ok(await supervisor.startRunAttempt(runId, dequeued.snapshot.friendlyId, {}));

  const token = await api.createWaitpointToken({});
  await api.waitForWaitpointToken({ runFriendlyId: runId, waitpointFriendlyId: token.id });

  const { execution } = ok(await supervisor.getLatestSnapshot(runId));
  return { runId, snapshotId: execution.snapshot.friendlyId, tokenId: token.id };
}

function ok<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}
