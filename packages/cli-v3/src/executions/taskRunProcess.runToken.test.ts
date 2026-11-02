import type {
  MachinePresetResources,
  ServerBackgroundWorker,
  WorkerManifest,
} from "@trigger.dev/core/v3";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRunProcess } from "./taskRunProcess.js";

const childPath = fileURLToPath(new URL("../../test/fixtures/runTokenChild.ts", import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

let processes: TaskRunProcess[] = [];

afterEach(async () => {
  await Promise.all(processes.map((p) => p.kill("SIGKILL")));
  processes = [];
});

function startChild(env: Record<string, string>) {
  const taskRunProcess = new TaskRunProcess({
    workerManifest: {
      runtime: "node",
      workerEntryPoint: childPath,
      loaderEntryPoint: tsxLoader,
      configEntryPoint: childPath,
    } as unknown as WorkerManifest,
    serverWorker: {} as ServerBackgroundWorker,
    env: { FIXTURE_RUN_ID: "run_a", FIXTURE_ATTEMPT: "2", TRIGGER_RUN_TOKEN: "initial", ...env },
    machineResources: { cpu: 1, memory: 1 } as MachinePresetResources,
  }).initialize();
  processes.push(taskRunProcess);
  return taskRunProcess;
}

async function childRunToken(taskRunProcess: TaskRunProcess) {
  const logged = taskRunProcess.onSendDebugLog.waitFor(10_000);
  await taskRunProcess.cleanup(false);
  return (await logged).message;
}

describe("TaskRunProcess.installRunToken", () => {
  it("updates the task process environment once the child acknowledges", async () => {
    const child = startChild({});

    await expect(
      child.installRunToken({ runId: "run_a", attemptNumber: 2, token: "refreshed" })
    ).resolves.toEqual({ result: "success" });
    expect(await childRunToken(child)).toBe("refreshed");
  }, 20_000);

  it("refuses an update for an earlier attempt after the process was reused", async () => {
    const child = startChild({});

    await expect(
      child.installRunToken({ runId: "run_a", attemptNumber: 1, token: "stale" })
    ).resolves.toEqual({ result: "failure", reason: "identity_mismatch" });
    await expect(
      child.installRunToken({ runId: "run_b", attemptNumber: 2, token: "other-run" })
    ).resolves.toEqual({ result: "failure", reason: "identity_mismatch" });
    expect(await childRunToken(child)).toBe("initial");
  }, 20_000);

  it("reports a child without the update handler as not installed", async () => {
    const child = startChild({ FIXTURE_LEGACY_CHILD: "1" });

    await expect(
      child.installRunToken({ runId: "run_a", attemptNumber: 2, token: "refreshed" })
    ).resolves.toEqual({ result: "failure", reason: "unsupported" });
    expect(await childRunToken(child)).toBe("initial");
  }, 20_000);

  it("reports a missing child without throwing", async () => {
    const child = startChild({});
    await child.kill("SIGKILL", 5_000);

    await expect(
      child.installRunToken({ runId: "run_a", attemptNumber: 2, token: "refreshed" })
    ).resolves.toEqual({ result: "failure", reason: "no_child" });
  }, 20_000);
});
