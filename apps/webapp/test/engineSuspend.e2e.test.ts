import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { ApiClient } from "@trigger.dev/core/v3";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { SupervisorHttpClient, WORKER_HEADERS } from "@trigger.dev/core/v3/runEngineWorker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MANAGED_WORKER_SECRET,
  seedEngineFixtures,
  type EngineFixtures,
} from "./bench/lib/engineFixtures";
import { seedTestPAT, seedTestUser } from "./helpers/seedTestPAT";

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

  // Catches: a suspend of a SUSPENDED run stored, or answered as anything but a discard.
  it("answers discarded for a suspend naming a SUSPENDED snapshot, and stores nothing", async () => {
    const { runId, snapshotId } = await runWaitingOnToken();
    const first = { type: "KUBERNETES" as const, location: "suspend-e2e/status-first" };
    const second = { type: "KUBERNETES" as const, location: "suspend-e2e/status-second" };
    const rows = (location: string) =>
      server.prisma.taskRunCheckpoint.count({ where: { location } });
    expect([await rows(first.location), await rows(second.location)]).toEqual([0, 0]);

    expect(
      ok(
        await supervisor.submitSuspendCompletion({
          runId,
          snapshotId,
          body: { success: true, checkpoint: first },
        })
      )
    ).toEqual({ ok: true });
    const suspended = ok(await supervisor.getLatestSnapshot(runId)).execution.snapshot;
    expect(suspended.executionStatus).toBe("SUSPENDED");

    expect(
      ok(
        await supervisor.submitSuspendCompletion({
          runId,
          snapshotId: suspended.friendlyId,
          body: { success: true, checkpoint: second },
        })
      )
    ).toEqual({ ok: true, discarded: { error: "Status SUSPENDED is not checkpointable" } });
    const latest = ok(await supervisor.getLatestSnapshot(runId)).execution.snapshot;
    expect([latest.friendlyId, latest.executionStatus]).toEqual([
      suspended.friendlyId,
      "SUSPENDED",
    ]);
    expect([await rows(first.location), await rows(second.location)]).toEqual([1, 0]);
  }, 60_000);

  // Catches: a failed suspend report stored as a checkpoint or answered as an error.
  it("answers ok to a suspend with success false, and changes nothing", async () => {
    const { runId, snapshotId } = await runWaitingOnToken();
    const envRows = () =>
      server.prisma.taskRunCheckpoint.count({
        where: { runtimeEnvironmentId: fixtures.environmentId },
      });
    const before = await envRows();

    expect(
      ok(
        await supervisor.submitSuspendCompletion({
          runId,
          snapshotId,
          body: { success: false, error: "checkpoint service could not freeze the run" },
        })
      )
    ).toEqual({ ok: true });
    const latest = ok(await supervisor.getLatestSnapshot(runId)).execution.snapshot;
    expect([latest.friendlyId, latest.executionStatus]).toEqual([
      snapshotId,
      "EXECUTING_WITH_WAITPOINTS",
    ]);
    expect(await envRows()).toBe(before);
  }, 60_000);

  // Catches: a change to the status or body a suspend for a missing run gets.
  it("answers a suspend for a run that does not exist with the status recorded on base", async () => {
    const location = "suspend-e2e/missing-run";
    const runId = generateFriendlyId("run");
    const response = await server.webapp.fetch(
      `/engine/v1/worker-actions/runs/${runId}/snapshots/${generateFriendlyId("snapshot")}/suspend`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixtures.workerGroupToken}`,
          [WORKER_HEADERS.INSTANCE_NAME]: "suspend-e2e",
          [WORKER_HEADERS.MANAGED_SECRET]: MANAGED_WORKER_SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ success: true, checkpoint: { type: "KUBERNETES", location } }),
      }
    );
    const body = await response.text();
    // Recorded on base: the engine throws for a run that does not exist and the route rethrows it.
    expect({ status: response.status, body }).toEqual({
      status: 500,
      body: '{"error":"Internal Server Error"}',
    });
    expect(await server.prisma.taskRunCheckpoint.count({ where: { location } })).toBe(0);
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

describe("worker group created with no project", () => {
  // Catches: a project-less worker group whose queue is not its name, so its supervisor dequeues
  // from a queue no run is published to, or whose token the dequeue route refuses.
  // Creating a managed group with no global default sets the `defaultWorkerInstanceGroupId` flag;
  // the fixtures' project has its own default worker group, so the file's other tests are unaffected.
  it("has its name as its queue and its token is accepted by the dequeue route", async () => {
    const user = await seedTestUser(server.prisma, { admin: true });
    const pat = await seedTestPAT(server.prisma, user.id);
    const name = "us-east-1:v2:ondemand:restore:container:stable";

    const response = await server.webapp.fetch("/admin/api/v1/workers", {
      method: "POST",
      headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.outcome).toBe("created new worker group");
    expect(body.workerGroup).toMatchObject({ name, masterQueue: name, projectId: null });
    expect(body.token.plaintext).toEqual(expect.any(String));

    const stored = await server.prisma.workerInstanceGroup.findFirstOrThrow({
      where: { id: body.workerGroup.id },
    });
    expect([stored.masterQueue, stored.projectId]).toEqual([name, null]);

    const groupSupervisor = new SupervisorHttpClient({
      apiUrl: server.webapp.baseUrl,
      workerToken: body.token.plaintext,
      instanceName: "no-project-group",
      managedWorkerSecret: MANAGED_WORKER_SECRET,
    });
    expect(await groupSupervisor.dequeue({})).toEqual({ success: true, data: [] });
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
