import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TaskRunExecution, WorkerManifest } from "@trigger.dev/core/v3";
import { TaskRunProcess } from "../executions/taskRunProcess.js";

const payloadSentinel = "payload-sentinel-9c1d";
const metadataSentinel = "metadata-sentinel-4e7a";

const workerSource = fileURLToPath(new URL("./managed-run-worker.ts", import.meta.url));

// The worker is TypeScript, so the forked entry point registers tsx and then imports it.
const tsxApi = createRequire(import.meta.url).resolve("tsx/esm/api");

async function createWorkerDir() {
  const dir = await mkdtemp(join(tmpdir(), "managed-run-worker-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const configPath = join(dir, "trigger.config.mjs");
  const workerEntryPoint = join(dir, "worker.mjs");

  const workerManifest: WorkerManifest = {
    configPath,
    tasks: [],
    workerEntryPoint,
    runtime: "node",
  };

  await writeFile(configPath, "export default {};\n");
  await writeFile(
    workerEntryPoint,
    [
      `import tsx from ${JSON.stringify(pathToFileURL(tsxApi).href)};`,
      "tsx.register();",
      `await import(${JSON.stringify(pathToFileURL(workerSource).href)});`,
      "",
    ].join("\n")
  );
  await writeFile(join(dir, "index.json"), JSON.stringify(workerManifest));

  return { dir, workerManifest };
}

function execution(): TaskRunExecution {
  const now = new Date();

  return {
    attempt: { number: 1, startedAt: now },
    run: {
      id: "run_workerlogtest",
      payload: JSON.stringify({ card: payloadSentinel }),
      payloadType: "application/json",
      tags: [],
      isTest: false,
      isReplay: false,
      createdAt: now,
      startedAt: now,
      metadata: { note: metadataSentinel },
    },
    task: { id: "missing-task", filePath: "src/trigger/missing.ts" },
    queue: { id: "queue_1", name: "task/missing-task" },
    environment: { id: "env_1", slug: "prod", type: "PRODUCTION" },
    organization: { id: "org_1", slug: "org", name: "Org" },
    project: { id: "proj_1", ref: "proj_ref", slug: "proj", name: "Project" },
    machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
  };
}

describe("managed run worker execute logging", () => {
  it("prints identifiers but not the payload or metadata when it receives the execution", async () => {
    const { dir, workerManifest } = await createWorkerDir();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => consoleLog.mockRestore());

    const taskRunProcess = new TaskRunProcess({
      workerManifest,
      serverWorker: { id: "worker_1", version: "20261027.1", contentHash: "hash" },
      // The worker builds its API client at module load, and the dead port makes its flush fail fast.
      env: { TRIGGER_SECRET_KEY: "tr_test_key", TRIGGER_API_URL: "http://127.0.0.1:9" },
      machineResources: { cpu: 0.5, memory: 0.5 },
      cwd: dir,
    });
    onTestFinished(() => taskRunProcess.kill());

    taskRunProcess.initialize();

    const result = await taskRunProcess.execute({
      payload: { execution: execution(), traceContext: {}, metrics: [] },
      messageId: "msg_1",
    });

    expect(result.ok).toBe(false);

    const stdout = consoleLog.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(stdout, "payload reached the runner's stdout").not.toContain(payloadSentinel);
    expect(stdout, "metadata reached the runner's stdout").not.toContain(metadataSentinel);
    expect(stdout).toContain("Received EXECUTE_TASK_RUN");
    expect(stdout).toMatch(/taskId: ['"]missing-task['"]/);
    expect(stdout).toContain("attemptNumber: 1");
  }, 60_000);
});
