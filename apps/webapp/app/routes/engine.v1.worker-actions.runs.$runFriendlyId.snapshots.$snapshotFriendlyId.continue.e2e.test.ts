import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { ApiClient } from "@trigger.dev/core/v3";
import { SupervisorHttpClient, WORKER_HEADERS } from "@trigger.dev/core/v3/runEngineWorker";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MANAGED_WORKER_SECRET,
  seedEngineFixtures,
  workerHeaders,
  type EngineFixtures,
} from "../../test/bench/lib/engineFixtures";

const INSTANCE_NAME = "continue-e2e";
const RUNNER_ID = "runner-continue-e2e";
const E2E_RETRY_BUDGET = {
  budgetMs: 30_000,
  minDelayMs: 100,
  maxDelayMs: 500,
  minAttemptBudgetMs: 1_000,
};

let server: TestServer;
let fixtures: EngineFixtures;
let api: ApiClient;
let supervisor: SupervisorHttpClient;
let retryableContinueFailures = 0;

beforeAll(async () => {
  server = await startTestServer({
    extraEnv: { RUN_ENGINE_CONTINUE_RETRYABLE_ERRORS_ENABLED: "true" },
    // The engine worker is what requeues a run once its waitpoint completes.
    overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" },
  });
  fixtures = await seedEngineFixtures(server.prisma, { taskCount: 1 });
  api = new ApiClient(server.webapp.baseUrl, fixtures.environmentApiKey);
  supervisor = new SupervisorHttpClient({
    apiUrl: server.webapp.baseUrl,
    workerToken: fixtures.workerGroupToken,
    instanceName: INSTANCE_NAME,
    managedWorkerSecret: MANAGED_WORKER_SECRET,
    onHttpRequestComplete(metric) {
      if (metric.name === "continue_run_execution" && metric.status === "503") {
        retryableContinueFailures++;
      }
    },
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

describe("continue after a restore from a checkpoint", () => {
  it("answers a retry of a continue that already succeeded with the same result", async () => {
    const { runId, snapshotId } = await restoreFromCheckpoint();

    const first = await continueRun(runId, snapshotId);
    const retry = await continueRun(runId, snapshotId);

    expect(first.success).toBe(true);
    expect(retry).toEqual(first);
  }, 60_000);

  it("keeps retrying through a database outage and succeeds once it ends", async () => {
    const { runId, snapshotId } = await restoreFromCheckpoint();

    const outage = await startDatabaseOutage();
    let continued: ReturnType<typeof continueRun>;
    try {
      // A single request, because the client retries. It gets past worker auth because that is
      // served from the in-process cache the earlier calls warmed; a cold cache would answer 401.
      const duringOutage = await server.webapp.fetch(
        `/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/continue`,
        {
          headers: {
            ...workerHeaders(fixtures, INSTANCE_NAME),
            [WORKER_HEADERS.ENVIRONMENT_ID]: fixtures.environmentId,
          },
        }
      );
      expect(duringOutage.status).toBe(503);

      const failuresBeforeContinue = retryableContinueFailures;
      continued = continueRun(runId, snapshotId, E2E_RETRY_BUDGET);
      await vi.waitFor(
        () => expect(retryableContinueFailures).toBeGreaterThan(failuresBeforeContinue),
        { timeout: 5_000, interval: 50 }
      );
    } finally {
      await outage.end();
    }

    const { success, retry } = await continued;
    expect(success).toBe(true);
    expect(retry?.outcome).toBe("succeeded");
    expect(retry?.attempts).toBeGreaterThan(1);
  }, 60_000);
});

function continueRun(
  runId: string,
  snapshotId: string,
  retryBudget?: {
    budgetMs: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    minAttemptBudgetMs?: number;
  }
) {
  return supervisor.continueRunExecution(runId, snapshotId, RUNNER_ID, fixtures.environmentId, {
    retryBudget,
  });
}

/**
 * Takes a run to the point where its runner, restored from a checkpoint, calls `continue`: the
 * run starts, blocks on a waitpoint and is checkpointed, then the waitpoint completes and the run
 * is dequeued again. Returns the snapshot `continue` is called with.
 */
async function restoreFromCheckpoint() {
  const { id: runId } = await api.triggerTask(fixtures.taskIdentifiers[0]!, { payload: {} });
  const dequeued = await dequeue();
  ok(await supervisor.startRunAttempt(runId, dequeued.snapshot.friendlyId, {}));

  const token = await api.createWaitpointToken({});
  await api.waitForWaitpointToken({ runFriendlyId: runId, waitpointFriendlyId: token.id });

  const { execution } = ok(await supervisor.getLatestSnapshot(runId));
  ok(
    await supervisor.submitSuspendCompletion({
      runId,
      snapshotId: execution.snapshot.friendlyId,
      body: { success: true, checkpoint: { type: "DOCKER", location: "e2e-checkpoint" } },
    })
  );

  await api.completeWaitpointToken(token.id, {});
  const restored = await dequeue();
  expect(restored.snapshot.executionStatus).toBe("PENDING_EXECUTING");

  return { runId, snapshotId: restored.snapshot.friendlyId };
}

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

/** Closes the webapp's database to new connections and drops the open ones. */
async function startDatabaseOutage() {
  const url = new URL(server.databaseUrl);
  const database = url.pathname.slice(1);
  url.pathname = "/postgres";

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS false`);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [
    database,
  ]);

  return {
    async end() {
      await admin.query(`ALTER DATABASE "${database}" WITH ALLOW_CONNECTIONS true`);
      await admin.end();
    },
  };
}

function ok<T>(result: { success: true; data: T } | { success: false; error: string }): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}
