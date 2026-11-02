import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { ApiClient } from "@trigger.dev/core/v3";
import { SupervisorHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MANAGED_WORKER_SECRET, seedEngineFixtures } from "../../test/bench/lib/engineFixtures";

const RUNNER_ID = "runner-release-e2e";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    // Only a release can requeue the run within these tests.
    extraEnv: { RUN_ENGINE_TIMEOUT_PENDING_EXECUTING: "600000" },
    // The engine worker moves runs from the master queue to the worker queue.
    overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" },
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

describe("release a dequeued run that never started", () => {
  it("requeues the run without waiting for the stall timeout and gives back its slot", async () => {
    const { api, supervisor, environmentId, taskIdentifier } = await setup("release-requeue");
    const { id: runId } = await api.triggerTask(taskIdentifier, { payload: {} });
    const dequeued = await dequeue(supervisor);

    const released = await supervisor.releaseRun(
      runId,
      dequeued.snapshot.friendlyId,
      { reason: "PodFailed" },
      RUNNER_ID,
      environmentId
    );
    expect(released).toEqual({ success: true, data: { ok: true, requeued: true } });

    const { execution } = ok(await supervisor.getLatestSnapshot(runId));
    expect(execution.snapshot.executionStatus).toBe("QUEUED");
    expect(execution.snapshot.description).toBe("Released before the run started: PodFailed");

    // The queue's limit is 1, so the run is dequeued again only if its slot was given back.
    const redelivered = await dequeue(supervisor);
    expect(redelivered.run.friendlyId).toBe(runId);
    expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
    ok(await supervisor.startRunAttempt(runId, redelivered.snapshot.friendlyId, {}));
  }, 60_000);

  it("refuses a run that has started and says not to retry", async () => {
    const { api, supervisor, environmentId, taskIdentifier } = await setup("release-started");
    const { id: runId } = await api.triggerTask(taskIdentifier, { payload: {} });
    const dequeued = await dequeue(supervisor);
    ok(await supervisor.startRunAttempt(runId, dequeued.snapshot.friendlyId, {}));

    const released = await supervisor.releaseRun(
      runId,
      dequeued.snapshot.friendlyId,
      { reason: "PodFailed" },
      RUNNER_ID,
      environmentId
    );
    expect(released).toMatchObject({
      success: false,
      statusCode: 409,
      shouldRetry: false,
      error: "The run is not at this dequeued snapshot, or this worker group does not serve it",
    });

    const { execution } = ok(await supervisor.getLatestSnapshot(runId));
    expect(execution.snapshot.executionStatus).toBe("EXECUTING");
  }, 60_000);

  it("answers a run outside the caller's environment with a 409, never a 404", async () => {
    const { api, supervisor, taskIdentifier } = await setup("release-other-env");
    const { id: runId } = await api.triggerTask(taskIdentifier, { payload: {} });
    const dequeued = await dequeue(supervisor);

    const released = await supervisor.releaseRun(
      runId,
      dequeued.snapshot.friendlyId,
      { reason: "PodFailed" },
      RUNNER_ID,
      "env_not_the_runs"
    );
    expect(released).toMatchObject({ success: false, statusCode: 409, shouldRetry: false });

    const { execution } = ok(await supervisor.getLatestSnapshot(runId));
    expect(execution.snapshot.friendlyId).toBe(dequeued.snapshot.friendlyId);
  }, 60_000);

  it("accepts a release from another worker instance of the same group that never dequeued", async () => {
    const { api, supervisor, environmentId, taskIdentifier, workerGroupToken } =
      await setup("release-dequeuer");
    const { id: runId } = await api.triggerTask(taskIdentifier, { payload: {} });
    const dequeued = await dequeue(supervisor);
    // A process that only watches failed pods: same group token, its own instance name, no dequeue.
    const watcher = new SupervisorHttpClient({
      apiUrl: server.webapp.baseUrl,
      workerToken: workerGroupToken,
      instanceName: "release-watcher",
      managedWorkerSecret: MANAGED_WORKER_SECRET,
    });

    const released = await watcher.releaseRun(
      runId,
      dequeued.snapshot.friendlyId,
      { reason: "PodFailed" },
      "runner-from-the-watcher",
      environmentId
    );
    expect(released).toEqual({ success: true, data: { ok: true, requeued: true } });

    const { execution } = ok(await supervisor.getLatestSnapshot(runId));
    expect(execution.snapshot.executionStatus).toBe("QUEUED");
  }, 60_000);

  it("answers a run that does not exist with a 409, even without the environment header", async () => {
    const { supervisor } = await setup("release-missing-run");

    const released = await supervisor.releaseRun(
      "run_doesnotexist0000000000",
      "snapshot_doesnotexist00000",
      { reason: "PodFailed" },
      RUNNER_ID
    );
    expect(released).toMatchObject({ success: false, statusCode: 409, shouldRetry: false });
  }, 60_000);
});

async function setup(instanceName: string) {
  const fixtures = await seedEngineFixtures(server.prisma, { taskCount: 1, concurrencyLimit: 1 });
  return {
    api: new ApiClient(server.webapp.baseUrl, fixtures.environmentApiKey),
    supervisor: new SupervisorHttpClient({
      apiUrl: server.webapp.baseUrl,
      workerToken: fixtures.workerGroupToken,
      instanceName,
      managedWorkerSecret: MANAGED_WORKER_SECRET,
    }),
    environmentId: fixtures.environmentId,
    taskIdentifier: fixtures.taskIdentifiers[0]!,
    workerGroupToken: fixtures.workerGroupToken,
  };
}

function dequeue(supervisor: SupervisorHttpClient) {
  return vi.waitFor(
    async () => {
      const [message] = ok(await supervisor.dequeue({}));
      if (!message) throw new Error("Nothing dequeued yet");
      return message;
    },
    { timeout: 10_000, interval: 100 }
  );
}

function ok<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}
