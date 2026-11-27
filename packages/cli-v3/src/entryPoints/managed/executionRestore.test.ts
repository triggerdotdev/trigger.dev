import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  CompletedWaitpoint,
  RunExecutionData,
  TaskRunExecution,
  TaskRunExecutionStatus,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { WorkloadHttpClient } from "@trigger.dev/core/v3/runEngineWorker";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRunProcess } from "../../executions/taskRunProcess.js";
import type { SupervisorSocket } from "./controller.js";
import { RunnerEnv } from "./env.js";
import { RunExecution } from "./execution.js";
import type { TaskRunProcessProvider } from "./taskRunProcessProvider.js";

// These tests drive the real RunExecution and WorkloadHttpClient against a local HTTP stand-in for
// the supervisor. The runner learns about new snapshots only when a test notifies it or when it
// fetches them itself: its poll is 10 minutes away.

const RUN = "run_1";

const waitpoint: CompletedWaitpoint = {
  id: "waitpoint_1",
  friendlyId: "waitpoint_1",
  type: "MANUAL",
  completedAt: new Date(),
  outputIsError: false,
};

const taskRunExecution: TaskRunExecution = {
  task: { id: "task", filePath: "task.ts" },
  attempt: { number: 1, startedAt: new Date() },
  run: {
    id: RUN,
    payload: "{}",
    payloadType: "application/json",
    tags: [],
    isTest: false,
    isReplay: false,
    createdAt: new Date(),
    startedAt: new Date(),
    traceContext: {},
  },
  queue: { id: "queue_1", name: "queue" },
  environment: { id: "env_1", slug: "prod", type: "PRODUCTION" },
  organization: { id: "org_1", slug: "org", name: "org" },
  project: { id: "proj_1", ref: "proj_ref", slug: "project", name: "project" },
  machine: { name: "micro", cpu: 0.25, memory: 0.25, centsPerMs: 0 },
};

class Supervisor {
  readonly snapshots: RunExecutionData[] = [];
  /** The snapshot id each completion named. */
  readonly completions: string[] = [];
  readonly continued: Array<{ fromSnapshotId: string; returnedSnapshotId: string }> = [];
  /** What the metadata service reports once the runner has been restored elsewhere. */
  restoredRunnerId?: string;
  /** Whether continue returns the snapshot it created, as a current platform does. */
  continueReturnsExecutionData = true;
  /**
   * How many snapshots/since requests after a continue are answered as a lagging read replica
   * would: without the snapshot continue created.
   */
  laggingFetchesAfterContinue = 0;
  /** snapshots/since requests received since the last continue. */
  fetchesAfterContinue = 0;
  /** Extra values the metadata service reports, e.g. a new supervisor port after a restore. */
  extraEnv: Record<string, unknown> = {};
  /** Requests arriving on this port are never answered (an old node's supervisor after a restore). */
  hangPort?: number;
  /** snapshots/since requests left hanging on hangPort. */
  hungFetches = 0;
  private readonly servers: Server[] = [];

  private constructor(private readonly server: Server) {
    this.servers.push(server);
  }

  static async start() {
    const server = createServer();
    const supervisor = new Supervisor(server);
    supervisor.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return supervisor;
  }

  private attach(server: Server) {
    server.on("request", (req, res) => {
      if (
        this.hangPort !== undefined &&
        req.socket.localPort === this.hangPort &&
        (req.url ?? "").startsWith("/api/v1/workload-actions/")
      ) {
        if (/\/snapshots\/since\//.test(req.url ?? "")) this.hungFetches++;
        return; // never answered
      }
      req.resume();
      req.on("end", () => {
        const { status, body } = this.handle(req.method ?? "", req.url ?? "");
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      });
    });
  }

  /** A second supervisor address serving the same run state (another node's supervisor). */
  async listenAgain() {
    const server = createServer();
    this.attach(server);
    this.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  get port() {
    return (this.server.address() as AddressInfo).port;
  }

  get latestSnapshotId() {
    return this.snapshots[this.snapshots.length - 1]?.snapshot.friendlyId;
  }

  /** The engine creates a snapshot. Ids sort in creation order, as the runner expects. */
  add(executionStatus: TaskRunExecutionStatus, completedWaitpoints: CompletedWaitpoint[] = []) {
    const friendlyId = `snapshot_${String(this.snapshots.length + 1).padStart(2, "0")}`;
    this.snapshots.push({
      version: "1",
      snapshot: {
        id: friendlyId,
        friendlyId,
        executionStatus,
        description: executionStatus,
        createdAt: new Date(Date.now() + this.snapshots.length),
      },
      run: { id: RUN, friendlyId: RUN, status: "EXECUTING", attemptNumber: 1 },
      completedWaitpoints,
    });
    return friendlyId;
  }

  since(snapshotId: string) {
    return this.snapshots.filter((s) => s.snapshot.friendlyId > snapshotId);
  }

  private handle(method: string, url: string): { status: number; body?: unknown } {
    if (method === "GET" && url === "/env") {
      return { status: 200, body: { TRIGGER_RUNNER_ID: this.restoredRunnerId, ...this.extraEnv } };
    }

    if (method === "POST" && url.endsWith("/logs/debug")) {
      return { status: 200, body: {} };
    }

    const sinceSnapshotId = url.match(/\/snapshots\/since\/([^/]+)$/)?.[1];

    if (method === "GET" && sinceSnapshotId) {
      const lastContinued = this.continued[this.continued.length - 1];

      if (lastContinued) {
        this.fetchesAfterContinue++;

        if (this.fetchesAfterContinue <= this.laggingFetchesAfterContinue) {
          const snapshots = this.since(sinceSnapshotId).filter(
            (s) => s.snapshot.friendlyId < lastContinued.returnedSnapshotId
          );
          return { status: 200, body: { snapshots } };
        }
      }

      return { status: 200, body: { snapshots: this.since(sinceSnapshotId) } };
    }

    const [, snapshotId, action] =
      url.match(
        /\/runs\/[^/]+\/snapshots\/([^/]+)\/(attempts\/start|attempts\/complete|continue|heartbeat)$/
      ) ?? [];

    if (!snapshotId || !action) {
      return { status: 404 };
    }

    if (action === "heartbeat") {
      return { status: 200, body: { ok: true } };
    }

    if (action === "attempts/start") {
      this.add("EXECUTING");
      const { snapshot, run } = this.snapshots[this.snapshots.length - 1]!;
      return {
        status: 200,
        body: { snapshot, run, envVars: {}, execution: taskRunExecution },
      };
    }

    if (action === "continue") {
      const returnedSnapshotId = this.add("EXECUTING", [waitpoint]);
      this.continued.push({ fromSnapshotId: snapshotId, returnedSnapshotId });
      this.fetchesAfterContinue = 0;
      const executionData = this.snapshots[this.snapshots.length - 1]!;
      const { snapshot, run } = executionData;
      return {
        status: 200,
        body: this.continueReturnsExecutionData
          ? { snapshot, run, executionData }
          : { snapshot, run },
      };
    }

    this.completions.push(snapshotId);

    // A completion is accepted only when it names the run's latest snapshot.
    if (snapshotId !== this.latestSnapshotId) {
      return { status: 500 };
    }

    this.add("FINISHED");
    const { snapshot, run } = this.snapshots[this.snapshots.length - 1]!;
    return { status: 200, body: { result: { attemptStatus: "RUN_FINISHED", snapshot, run } } };
  }

  async stop() {
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
    );
  }
}

/** A task process that runs until the test says the task returned. */
function createTask() {
  let started!: () => void;
  let finish!: () => void;
  const hasStarted = new Promise<void>((resolve) => (started = resolve));
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const completedWaitpoints: CompletedWaitpoint[] = [];
  const evt = () => ({ attach() {} });

  const process = {
    isBeingKilled: false,
    onTaskRunHeartbeat: evt(),
    onSendDebugLog: evt(),
    onSetSuspendable: evt(),
    unsafeDetachEvtHandlers() {},
    waitpointCompleted(completed: CompletedWaitpoint) {
      completedWaitpoints.push(completed);
    },
    async execute() {
      started();
      await finished;
      return { ok: true, id: RUN, output: `"done"`, outputType: "application/json" };
    },
  } as unknown as TaskRunProcess;

  return { process, hasStarted, finish, completedWaitpoints };
}

function createExecution(
  supervisor: Supervisor,
  { restorable, pollIntervalSeconds = 600 }: { restorable: boolean; pollIntervalSeconds?: number }
) {
  const env = new RunnerEnv({
    TRIGGER_CONTENT_HASH: "hash",
    TRIGGER_PROJECT_ID: "proj_1",
    TRIGGER_PROJECT_REF: "proj_ref",
    TRIGGER_DEPLOYMENT_ID: "deploy_1",
    TRIGGER_DEPLOYMENT_VERSION: "20261020.1",
    TRIGGER_ENV_ID: "env_1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com/otel",
    TRIGGER_RUNNER_ID: "runner_1",
    TRIGGER_POD_SCHEDULED_AT_MS: "1",
    TRIGGER_DEQUEUED_AT_MS: "1",
    TRIGGER_SUPERVISOR_API_PROTOCOL: "http",
    TRIGGER_SUPERVISOR_API_DOMAIN: "127.0.0.1",
    TRIGGER_SUPERVISOR_API_PORT: String(supervisor.port),
    TRIGGER_WORKER_INSTANCE_NAME: "worker",
    // Snapshot changes reach the runner only when the test notifies it.
    TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS: String(pollIntervalSeconds),
    ...(restorable ? { TRIGGER_METADATA_URL: `http://127.0.0.1:${supervisor.port}` } : {}),
  });

  const httpClient = new WorkloadHttpClient({
    workerApiUrl: env.TRIGGER_SUPERVISOR_API_URL,
    runnerId: env.TRIGGER_RUNNER_ID,
    deploymentId: env.TRIGGER_DEPLOYMENT_ID,
    deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
    projectRef: env.TRIGGER_PROJECT_REF,
  });

  const socket = new EventEmitter();
  const task = createTask();

  const execution = new RunExecution({
    workerManifest: {} as WorkerManifest,
    env,
    httpClient,
    logger: { sendDebugLog: () => {} },
    supervisorSocket: socket as unknown as SupervisorSocket,
    taskRunProcessProvider: {
      hasPersistentProcess: false,
      getProcess: async () => task.process,
      returnProcess: async () => {},
      handleProcessAbort: async () => {},
      handleImmediateRetry: async () => {},
      suspendProcess: async () => {},
    } as unknown as TaskRunProcessProvider,
  });

  return {
    execution,
    task,
    /** The supervisor tells the runner its run changed; the runner then fetches the snapshots. */
    notify: () => socket.emit("run:notify", { version: "1", run: { friendlyId: RUN } }),
  };
}

/** Starts the attempt, then blocks the run on a waitpoint and lets the runner process that. */
async function startBlockedOnWaitpoint(
  supervisor: Supervisor,
  { execution, task, notify }: ReturnType<typeof createExecution>
) {
  const dequeued = supervisor.add("PENDING_EXECUTING");
  const done = execution.execute({ runFriendlyId: RUN, snapshotFriendlyId: dequeued });
  await task.hasStarted;

  const blocked = supervisor.add("EXECUTING_WITH_WAITPOINTS");
  notify();
  await vi.waitFor(() => expect(execution.currentSnapshotFriendlyId).toBe(blocked));

  return { done };
}

let supervisor: Supervisor;

afterEach(async () => {
  await supervisor.stop();
});

describe("RunExecution after a restore", () => {
  // Catches: a restored runner leaving the EXECUTING snapshot that continue created to its next
  // poll, so the task resumes seconds late and a completion in between names a replaced snapshot,
  // or fetching that snapshot although continue returned it.
  it(
    "takes in the snapshot continue returned right after a restore, without fetching it",
    { timeout: 30_000 },
    async () => {
      supervisor = await Supervisor.start();
      const runner = createExecution(supervisor, { restorable: true });
      const { done } = await startBlockedOnWaitpoint(supervisor, runner);

      // The run is suspended, its waitpoint completes, and it is dequeued for a restore.
      supervisor.add("SUSPENDED");
      supervisor.add("QUEUED");
      const pendingExecuting = supervisor.add("PENDING_EXECUTING", [waitpoint]);
      supervisor.restoredRunnerId = "runner_2";
      runner.notify();

      // The restored runner continues the run, which creates the EXECUTING snapshot. Nothing
      // notifies the runner after this and its poll is 10 minutes away.
      await vi.waitFor(() => expect(supervisor.continued).toHaveLength(1));
      const continuedSnapshotId = supervisor.latestSnapshotId;
      expect(supervisor.continued).toEqual([
        { fromSnapshotId: pendingExecuting, returnedSnapshotId: continuedSnapshotId },
      ]);

      // The runner adopts that snapshot and hands its completed waitpoint to the task.
      await vi.waitFor(() =>
        expect(runner.execution.currentSnapshotFriendlyId).toBe(continuedSnapshotId)
      );
      expect(runner.task.completedWaitpoints).toEqual([waitpoint]);
      // Longer than the fallback's tries take: none of them happen.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(supervisor.fetchesAfterContinue).toBe(0);

      runner.task.finish();
      await done;

      // The completion names the snapshot continue created, so it is accepted first time.
      expect(supervisor.completions).toEqual([continuedSnapshotId]);
    }
  );
});

describe("RunExecution after a restore, on a platform whose continue doesn't return the snapshot", () => {
  /** Suspends the blocked run, completes its waitpoint and dequeues it for a restore. */
  async function restore(runner: ReturnType<typeof createExecution>) {
    supervisor.add("SUSPENDED");
    supervisor.add("QUEUED");
    supervisor.add("PENDING_EXECUTING", [waitpoint]);
    supervisor.restoredRunnerId = "runner_2";
    runner.notify();

    await vi.waitFor(() => expect(supervisor.continued).toHaveLength(1));
    return supervisor.continued[0]!.returnedSnapshotId;
  }

  async function start({ laggingFetches }: { laggingFetches: number }) {
    supervisor = await Supervisor.start();
    supervisor.continueReturnsExecutionData = false;
    supervisor.laggingFetchesAfterContinue = laggingFetches;
    const runner = createExecution(supervisor, { restorable: true });
    const { done } = await startBlockedOnWaitpoint(supervisor, runner);
    const continuedSnapshotId = await restore(runner);
    return { runner, done, continuedSnapshotId };
  }

  // Catches: a restored runner on an older platform waiting for its poll, because continue didn't
  // return the snapshot and it doesn't fetch it.
  it("fetches the snapshot continue created", { timeout: 30_000 }, async () => {
    const { runner, done, continuedSnapshotId } = await start({ laggingFetches: 0 });

    await vi.waitFor(
      () => expect(runner.execution.currentSnapshotFriendlyId).toBe(continuedSnapshotId),
      { timeout: 5_000 }
    );
    expect(runner.task.completedWaitpoints).toEqual([waitpoint]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(supervisor.fetchesAfterContinue).toBe(1);

    runner.task.finish();
    await done;

    expect(supervisor.completions).toEqual([continuedSnapshotId]);
  });

  // Catches: a restored runner fetching once after continue, getting an empty list from a read
  // replica that hasn't got the new snapshot yet, and then waiting seconds for its poll.
  it(
    "fetches once more when a lagging read replica doesn't have it yet",
    { timeout: 30_000 },
    async () => {
      const { runner, done, continuedSnapshotId } = await start({ laggingFetches: 1 });

      await vi.waitFor(
        () => expect(runner.execution.currentSnapshotFriendlyId).toBe(continuedSnapshotId),
        { timeout: 5_000 }
      );
      expect(runner.task.completedWaitpoints).toEqual([waitpoint]);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(supervisor.fetchesAfterContinue).toBe(2);

      runner.task.finish();
      await done;

      expect(supervisor.completions).toEqual([continuedSnapshotId]);
    }
  );

  // Catches: a runner that fetches more than twice after continue, or breaks, when the replica
  // doesn't catch up within its tries.
  it(
    "stops after two tries and leaves the snapshot to a notification",
    { timeout: 30_000 },
    async () => {
      const { runner, done, continuedSnapshotId } = await start({
        laggingFetches: Number.POSITIVE_INFINITY,
      });

      await vi.waitFor(() => expect(supervisor.fetchesAfterContinue).toBe(2), { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(supervisor.fetchesAfterContinue).toBe(2);
      expect(runner.execution.currentSnapshotFriendlyId).not.toBe(continuedSnapshotId);

      // The replica catches up and the supervisor notifies the runner.
      supervisor.laggingFetchesAfterContinue = 0;
      runner.notify();

      await vi.waitFor(() =>
        expect(runner.execution.currentSnapshotFriendlyId).toBe(continuedSnapshotId)
      );
      expect(runner.task.completedWaitpoints).toEqual([waitpoint]);

      runner.task.finish();
      await done;

      expect(supervisor.completions).toEqual([continuedSnapshotId]);
    }
  );
});

describe("RunExecution after its controller replaces the supervisor socket", () => {
  // Catches: a runner restored under another supervisor still listening for run notifications on
  // the socket its controller replaced, so every later snapshot change waits for the poll.
  it("takes in a snapshot when notified on the new socket", { timeout: 30_000 }, async () => {
    supervisor = await Supervisor.start();
    const runner = createExecution(supervisor, { restorable: false });
    const { done } = await startBlockedOnWaitpoint(supervisor, runner);

    const newSocket = new EventEmitter();
    runner.execution.updateSupervisorSocket(newSocket as unknown as SupervisorSocket);

    // The waitpoint completes. Only the new socket is notified and the poll is 10 minutes away.
    const continued = supervisor.add("EXECUTING", [waitpoint]);
    newSocket.emit("run:notify", { version: "1", run: { friendlyId: RUN } });

    await vi.waitFor(() => expect(runner.execution.currentSnapshotFriendlyId).toBe(continued));
    expect(runner.task.completedWaitpoints).toEqual([waitpoint]);

    runner.task.finish();
    await done;
  });
});

describe("RunExecution restored under another supervisor while a poll to the old one hangs", () => {
  // Reproduces prod us-west-2 (2026-11-26 runner logs): a snapshot poll is in flight to the old
  // node's supervisor, which never answers; the runner then learns of the restore, switches to the
  // new supervisor, restores and continues. Catches: the task waiting for the stuck poll to give
  // up (~17.5 s with the 10 s timeout and retries) before it gets its completed waitpoint.
  for (const continueReturnsExecutionData of [true, false]) {
    it(
      `hands the waitpoint over without waiting for the stuck poll (continue returns snapshot: ${continueReturnsExecutionData})`,
      { timeout: 40_000 },
      async () => {
        supervisor = await Supervisor.start();
        supervisor.continueReturnsExecutionData = continueReturnsExecutionData;
        // The poller runs every second here, so one of its ticks lands after the restore.
        const runner = createExecution(supervisor, { restorable: true, pollIntervalSeconds: 1 });
        const { done } = await startBlockedOnWaitpoint(supervisor, runner);

        // It is restored on another node: the old supervisor stops answering, and the metadata
        // service reports the new runner id and the new supervisor's port. Set up before the
        // restore's snapshots exist, so no poll can pick them up from the old supervisor.
        const newPort = await supervisor.listenAgain();
        supervisor.hangPort = supervisor.port;
        supervisor.restoredRunnerId = "runner_2";
        // The prod default poll interval (5 s), so a runner without the fix recovers as it does in prod.
        supervisor.extraEnv = {
          TRIGGER_SUPERVISOR_API_PORT: newPort,
          TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS: 5,
        };

        // The run is suspended and its waitpoint completes; it is dequeued for a restore.
        supervisor.add("SUSPENDED");
        supervisor.add("QUEUED");
        supervisor.add("PENDING_EXECUTING", [waitpoint]);

        // The poller's next tick goes to the old supervisor and hangs. While a tick runs, the
        // poller schedules nothing else (as in prod).
        await vi.waitFor(() => expect(supervisor.hungFetches).toBe(1), { timeout: 5_000 });

        // The socket drops; the controller processes overrides and polls at once (as in prod).
        const started = Date.now();
        await runner.execution.processEnvOverrides("socket disconnected", true);

        await vi.waitFor(() => expect(supervisor.continued).toHaveLength(1), { timeout: 30_000 });
        const continuedSnapshotId = supervisor.continued[0]!.returnedSnapshotId;

        await vi.waitFor(
          () => expect(runner.execution.currentSnapshotFriendlyId).toBe(continuedSnapshotId),
          { timeout: 30_000 }
        );
        const handoverMs = Date.now() - started;
        expect(runner.task.completedWaitpoints).toEqual([waitpoint]);
        expect(handoverMs).toBeLessThan(3_000);

        runner.task.finish();
        await done;
      }
    );
  }
});
