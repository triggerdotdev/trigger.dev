import { TaskRunProcess, type TaskRunProcessOptions } from "./taskRunProcess.js";
import { describe, it, expect, vi } from "vitest";
import { UnexpectedExitError } from "@trigger.dev/core/v3/errors";
import type {
  TaskRunExecution,
  TaskRunExecutionPayload,
  WorkerManifest,
  ServerBackgroundWorker,
  MachinePresetResources,
} from "@trigger.dev/core/v3";

function createTaskRunProcessOptions(
  overrides: Partial<TaskRunProcessOptions> = {}
): TaskRunProcessOptions {
  return {
    workerManifest: {
      runtime: "node",
      workerEntryPoint: "/dev/null",
      configEntryPoint: "/dev/null",
      otelImportHook: {},
    } as unknown as WorkerManifest,
    serverWorker: {} as unknown as ServerBackgroundWorker,
    env: {},
    machineResources: { cpu: 1, memory: 1 } as MachinePresetResources,
    ...overrides,
  };
}

function createExecution(runId: string, attemptNumber: number): TaskRunExecution {
  return {
    run: {
      id: runId,
      payload: "{}",
      payloadType: "application/json",
      tags: [],
      isTest: false,
      createdAt: new Date(),
      startedAt: new Date(),
      maxAttempts: 3,
      version: "1",
      durationMs: 0,
      costInCents: 0,
      baseCostInCents: 0,
    },
    attempt: {
      number: attemptNumber,
      startedAt: new Date(),
      id: "deprecated",
      backgroundWorkerId: "deprecated",
      backgroundWorkerTaskId: "deprecated",
      status: "deprecated" as any,
    },
    task: { id: "test-task", filePath: "test.ts" },
    queue: { id: "queue-1", name: "test-queue" },
    environment: { id: "env-1", slug: "test", type: "DEVELOPMENT" },
    organization: { id: "org-1", slug: "test-org", name: "Test Org" },
    project: { id: "proj-1", ref: "proj_test", slug: "test", name: "Test" },
    machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
  } as unknown as TaskRunExecution;
}

describe("TaskRunProcess", () => {
  describe("execute() on a dead child process", () => {
    it("should reject when child process has already exited and IPC send is skipped", async () => {
      const proc = new TaskRunProcess(createTaskRunProcessOptions());

      // Simulate a child process that has exited: _child exists but is not connected
      const fakeChild = {
        connected: false,
        killed: false,
        pid: 12345,
        kill: vi.fn(),
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };

      // Set internal state to mimic a process whose child has crashed
      (proc as any)._child = fakeChild;
      (proc as any)._childPid = 12345;
      (proc as any)._isBeingKilled = false;

      const execution = createExecution("run-1", 2);

      // This should NOT hang forever - it should reject promptly.
      //
      // BUG: Currently execute() creates a promise, skips the IPC send because
      // _child.connected is false, then awaits the promise which will never
      // resolve because the child is dead and #handleExit already ran.
      //
      // The Promise.race with a timeout detects the hang.
      const result = await Promise.race([
        proc
          .execute(
            {
              payload: { execution, traceContext: {}, metrics: [] },
              messageId: "run_run-1",
              env: {},
            },
            true
          )
          .then(
            (v) => ({ type: "resolved" as const, value: v }),
            (e) => ({ type: "rejected" as const, error: e })
          ),
        new Promise<{ type: "hung" }>((resolve) =>
          setTimeout(() => resolve({ type: "hung" as const }), 2000)
        ),
      ]);

      // The test fails (proving the bug) if execute() hangs
      expect(result.type).not.toBe("hung");
      expect(result.type).toBe("rejected");

      if (result.type === "rejected") {
        expect(result.error).toBeInstanceOf(UnexpectedExitError);
        expect(result.error.stderr).toContain("not connected");
      }
    });
  });
});
