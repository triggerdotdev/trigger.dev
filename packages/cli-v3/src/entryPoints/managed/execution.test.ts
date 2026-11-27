import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io } from "socket.io-client";
import type { WorkerManifest } from "@trigger.dev/core/v3";
import {
  WorkloadHttpClient,
  type WorkloadDebugLogRequestBody,
  type WorkloadRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/runEngineWorker";
import type { SupervisorSocket } from "./controller.js";
import { RunnerEnv } from "./env.js";
import { RunExecution } from "./execution.js";
import { ManagedRunLogger } from "./logger.js";
import { SnapshotManager } from "./snapshot.js";
import { TaskRunProcessProvider } from "./taskRunProcessProvider.js";

const runFriendlyId = "run_logtest1";
const snapshotFriendlyId = "snapshot_logtest2";

const envVarValues = {
  CUSTOMER_SETTING: "customer-value-7f3e9c",
  TRIGGER_JWT: "eyJhbGciOi.jwt-sentinel-5a1b",
  SERVICE_SETTING: "service-value-0123",
};
const payloadSentinel = "payload-sentinel-2d4c";
const overrideValues = {
  TRIGGER_RUNNER_ID: "runner_2",
  TRIGGER_SNAPSHOT_ID: snapshotFriendlyId,
  EXTRA_SETTING: "override-value-8b2e",
};
const sentinels = [...Object.values(envVarValues), payloadSentinel];

const runnerEnv = {
  TRIGGER_CONTENT_HASH: "hash",
  TRIGGER_PROJECT_ID: "proj_1",
  TRIGGER_PROJECT_REF: "proj_ref",
  TRIGGER_DEPLOYMENT_ID: "deploy_1",
  TRIGGER_DEPLOYMENT_VERSION: "20261020.1",
  TRIGGER_ENV_ID: "env_1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  TRIGGER_RUNNER_ID: "runner_1",
  TRIGGER_POD_SCHEDULED_AT_MS: "1",
  TRIGGER_DEQUEUED_AT_MS: "1",
  TRIGGER_SUPERVISOR_API_PROTOCOL: "http",
  TRIGGER_SUPERVISOR_API_DOMAIN: "127.0.0.1",
  TRIGGER_WORKER_INSTANCE_NAME: "worker",
  TRIGGER_SEND_RUN_DEBUG_LOGS: "true",
};

function startResponse(): WorkloadRunAttemptStartResponseBody {
  const now = new Date();

  return {
    run: { id: "run_internal", friendlyId: runFriendlyId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: {
      id: "snapshot_internal",
      friendlyId: snapshotFriendlyId,
      executionStatus: "EXECUTING",
      description: "Attempt created",
      createdAt: now,
    },
    execution: {
      attempt: { number: 1, startedAt: now },
      run: {
        id: runFriendlyId,
        payload: JSON.stringify({ card: payloadSentinel }),
        payloadType: "application/json",
        tags: [],
        isTest: false,
        isReplay: false,
        createdAt: now,
        startedAt: now,
      },
      task: { id: "log-task", filePath: "src/trigger/log.ts" },
      queue: { id: "queue_1", name: "task/log-task" },
      environment: { id: "env_1", slug: "prod", type: "PRODUCTION" },
      organization: { id: "org_1", slug: "org", name: "Org" },
      project: { id: "proj_1", ref: "proj_ref", slug: "proj", name: "Project" },
      machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
    },
    envVars: envVarValues,
  };
}

// Stands in for the supervisor: answers the attempt start and records the run debug log posts.
async function startSupervisor() {
  const debugLogs: WorkloadDebugLogRequestBody[] = [];

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");

    if (req.method === "POST" && req.url?.endsWith("/attempts/start")) {
      res.end(JSON.stringify(startResponse()));
      return;
    }

    if (req.method === "GET" && req.url === "/env") {
      res.end(JSON.stringify(overrideValues));
      return;
    }

    if (req.method === "POST" && req.url?.endsWith("/logs/debug")) {
      debugLogs.push(JSON.parse(body));
      res.end("{}");
      return;
    }

    res.statusCode = 404;
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );

  return { port, debugLogs };
}

function createExecution(port: number) {
  const env = new RunnerEnv({
    ...runnerEnv,
    TRIGGER_SUPERVISOR_API_PORT: String(port),
    TRIGGER_METADATA_URL: `http://127.0.0.1:${port}`,
  });

  const httpClient = new WorkloadHttpClient({
    workerApiUrl: `http://127.0.0.1:${port}`,
    runnerId: env.TRIGGER_RUNNER_ID,
    deploymentId: env.TRIGGER_DEPLOYMENT_ID,
    deploymentVersion: env.TRIGGER_DEPLOYMENT_VERSION,
    projectRef: env.TRIGGER_PROJECT_REF,
  });

  const logger = new ManagedRunLogger({ httpClient, env });

  const workerManifest: WorkerManifest = {
    configPath: "trigger.config.ts",
    tasks: [],
    workerEntryPoint: "worker.js",
    runtime: "node",
  };

  const supervisorSocket: SupervisorSocket = io(`http://127.0.0.1:${port}`, {
    autoConnect: false,
  });

  const execution = new RunExecution({
    workerManifest,
    env,
    httpClient,
    logger,
    supervisorSocket,
    taskRunProcessProvider: new TaskRunProcessProvider({
      workerManifest,
      env,
      logger,
      processKeepAliveEnabled: false,
      processKeepAliveMaxExecutionCount: 1,
    }),
  });

  // execute() sets these before starting the attempt; set them without forking a task process.
  execution["_runFriendlyId"] = runFriendlyId;
  execution["snapshotManager"] = new SnapshotManager({
    runFriendlyId,
    runnerId: env.TRIGGER_RUNNER_ID,
    initialSnapshotId: "snapshot_logtest1",
    initialStatus: "PENDING_EXECUTING",
    logger,
    onSnapshotChange: async () => {},
    onSuspendable: async () => {},
  });

  return execution;
}

const expectedIdentifiers = {
  runId: runFriendlyId,
  snapshotId: snapshotFriendlyId,
  attemptNumber: 1,
  taskId: "log-task",
};

describe("RunExecution start attempt logging", () => {
  it("logs identifiers but no env var or payload values to stdout or the run debug logs", async () => {
    const supervisor = await startSupervisor();
    const execution = createExecution(supervisor.port);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => consoleLog.mockRestore());

    await execution["startAttempt"]({ isWarmStart: false });

    const stdout = consoleLog.mock.calls.map((args) => args.join(" "));

    for (const sentinel of sentinels) {
      expect(stdout.join("\n"), `${sentinel} reached stdout`).not.toContain(sentinel);
    }

    const startedLine = stdout.find((line) => line.includes("[execution] started attempt"));
    if (!startedLine) {
      throw new Error("started attempt was not printed");
    }
    expect(JSON.parse(startedLine)).toMatchObject(expectedIdentifiers);

    const posted = await vi.waitFor(
      () => {
        const log = supervisor.debugLogs.find(
          (entry) => entry.message === "[execution] started attempt"
        );
        if (!log) {
          throw new Error("started attempt never reached the supervisor");
        }
        return log;
      },
      { timeout: 5_000 }
    );

    for (const sentinel of sentinels) {
      expect(
        JSON.stringify(supervisor.debugLogs),
        `${sentinel} reached the run debug logs`
      ).not.toContain(sentinel);
    }

    expect(posted.properties).toMatchObject(expectedIdentifiers);
  });

  it("logs the override key names but not their values", async () => {
    const supervisor = await startSupervisor();
    const execution = createExecution(supervisor.port);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => consoleLog.mockRestore());

    const result = await execution.processEnvOverrides("restore");
    expect(result?.runnerIdChanged).toBe(true);

    const posted = await vi.waitFor(
      () => {
        const log = supervisor.debugLogs.find((entry) =>
          entry.message.startsWith("[execution] [override] processing")
        );
        if (!log) {
          throw new Error("override processing never reached the supervisor");
        }
        return log;
      },
      { timeout: 5_000 }
    );

    expect(posted.properties).toMatchObject({
      "overrideKeys.[0]": "TRIGGER_RUNNER_ID",
      "overrideKeys.[1]": "TRIGGER_SNAPSHOT_ID",
      "overrideKeys.[2]": "EXTRA_SETTING",
    });
    expect(JSON.stringify(supervisor.debugLogs)).not.toContain(overrideValues.EXTRA_SETTING);
    expect(consoleLog.mock.calls.flat().join(" ")).not.toContain(overrideValues.EXTRA_SETTING);
  });
});
