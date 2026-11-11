import { TaskRunProcess, trustStoreEnv, type TaskRunProcessOptions } from "./taskRunProcess.js";
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UncaughtExceptionError, UnexpectedExitError } from "@trigger.dev/core/v3/errors";
import type {
  TaskRunExecution,
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

describe("trustStoreEnv", () => {
  const controllerEnv = {
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
    PATH: "/usr/bin",
  };

  it("forwards the controller's trust store variables to the task process", () => {
    expect(trustStoreEnv(controllerEnv, {})).toEqual({
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
      PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
    });
  });

  it("lets the run's own variables win", () => {
    expect(trustStoreEnv(controllerEnv, { REQUESTS_CA_BUNDLE: "/app/corp.pem" })).toEqual({
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      REQUESTS_CA_BUNDLE: "/app/corp.pem",
      PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
    });
  });

  it("sets nothing when neither side defines them", () => {
    expect(trustStoreEnv({ PATH: "/usr/bin" }, {})).toEqual({});
  });

  it("lets the run's NODE_EXTRA_CA_CERTS win over the image's empty value", () => {
    expect(
      trustStoreEnv(
        { NODE_EXTRA_CA_CERTS: "" },
        { NODE_EXTRA_CA_CERTS: "/app/certs/corp-root.pem" }
      )
    ).toEqual({ NODE_EXTRA_CA_CERTS: "/app/certs/corp-root.pem" });
  });

  it("forwards NODE_EXTRA_CA_CERTS baked into the image when the run sets none", () => {
    expect(trustStoreEnv({ NODE_EXTRA_CA_CERTS: "/app/certs/corp-root.pem" }, {})).toEqual({
      NODE_EXTRA_CA_CERTS: "/app/certs/corp-root.pem",
    });
  });
});

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

  describe("parseExecuteError(UncaughtExceptionError)", () => {
    it("returns INTERNAL_ERROR with TASK_RUN_UNCAUGHT_EXCEPTION + original message and stack", () => {
      const error = new UncaughtExceptionError(
        {
          name: "Error",
          message: "read ECONNRESET",
          stack:
            "Error: read ECONNRESET\n    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)",
        },
        "uncaughtException"
      );

      const result = TaskRunProcess.parseExecuteError(error);

      expect(result.type).toBe("INTERNAL_ERROR");
      expect(result.code).toBe("TASK_RUN_UNCAUGHT_EXCEPTION");
      expect(result.message).toBe("read ECONNRESET");
      expect(result.stackTrace).toContain("TCP.onStreamRead");
    });

    it("uses the same code for unhandledRejection origin", () => {
      const error = new UncaughtExceptionError(
        { name: "TypeError", message: "boom" },
        "unhandledRejection"
      );

      const result = TaskRunProcess.parseExecuteError(error);

      expect(result.type).toBe("INTERNAL_ERROR");
      expect(result.code).toBe("TASK_RUN_UNCAUGHT_EXCEPTION");
      expect(result.message).toBe("boom");
    });
  });

  describe("a child killed with SIGKILL", () => {
    type Cgroup = { dir: string; events: string; writeEvents: (kills: number) => Promise<void> };

    // A fake cgroup whose out-of-memory counter the test writes.
    async function withCgroup<T>(run: (cgroup: Cgroup) => Promise<T>): Promise<T> {
      const dir = await mkdtemp(join(tmpdir(), "task-run-process-oom-"));
      try {
        await writeFile(join(dir, "cgroup"), "0::/run\n");
        await mkdir(join(dir, "sys", "run"), { recursive: true });
        const events = join(dir, "sys", "run", "memory.events");
        return await run({
          dir,
          events,
          writeEvents: (kills) => writeFile(events, eventsWith(kills)),
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    function eventsWith(kills: number) {
      return `low 0\nhigh 0\nmax 3\noom 4\noom_kill ${kills}\noom_group_kill 0\n`;
    }

    // Starts an attempt on a child running `childSource`, and returns what it fails with.
    async function attemptOn(
      cgroup: Cgroup,
      childSource: string,
      options: Partial<TaskRunProcessOptions> = {}
    ) {
      const entryPoint = join(cgroup.dir, "child.mjs");
      await writeFile(entryPoint, childSource);
      const proc = new TaskRunProcess(
        createTaskRunProcessOptions({
          workerManifest: {
            runtime: "node",
            workerEntryPoint: entryPoint,
            configEntryPoint: entryPoint,
            otelImportHook: {},
          } as unknown as WorkerManifest,
          serverWorker: { id: "worker-1", version: "1", contentHash: "hash" },
          env: { OOM_EVENTS: cgroup.events, OOM_EVENTS_AFTER: eventsWith(1) },
          oomKillCounter: {
            procSelfCgroup: join(cgroup.dir, "cgroup"),
            cgroupRoot: join(cgroup.dir, "sys"),
          },
          ...options,
        })
      ).initialize();

      const failure = proc
        .execute(
          {
            payload: { execution: createExecution("run-1", 1), traceContext: {}, metrics: [] },
            messageId: "run_run-1",
            env: {},
          },
          false
        )
        .then(
          () => {
            throw new Error("the attempt resolved");
          },
          (error: unknown) => TaskRunProcess.parseExecuteError(error)
        );
      return { proc, failure };
    }

    // Opens the FIFO for writing once its reader is waiting, so the blocked read sees end of file
    // and does not outlive the test.
    async function releaseReader(fifo: string) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }

    const IDLE_CHILD = "setInterval(() => {}, 1000);\n";

    // Counts an out-of-memory kill and dies by SIGKILL as soon as the attempt reaches it.
    const OOM_ON_EXECUTE_CHILD = [
      'import { writeFileSync } from "node:fs";',
      'process.on("message", () => {',
      "  writeFileSync(process.env.OOM_EVENTS, process.env.OOM_EVENTS_AFTER);",
      '  process.kill(process.pid, "SIGKILL");',
      "});",
      "",
    ].join("\n");

    async function killedAfterBaseline(oomKillsBefore: number, oomKillsAtKill: number) {
      return withCgroup(async (cgroup) => {
        await cgroup.writeEvents(oomKillsBefore);
        const { proc, failure } = await attemptOn(cgroup, IDLE_CHILD);
        // Let the attempt read its baseline before the kill is counted.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await cgroup.writeEvents(oomKillsAtKill);
        process.kill(proc.pid!, "SIGKILL");
        return failure;
      });
    }

    // Catches: an out-of-memory kill of the child failing the attempt as a generic non-zero
    // exit, so the run gets the wrong error and is retried as an ordinary crash.
    it("reports TASK_PROCESS_OOM_KILLED when the cgroup counted an out-of-memory kill", async () => {
      const error = await killedAfterBaseline(0, 1);

      expect(error.code).toBe("TASK_PROCESS_OOM_KILLED");
      expect(error.message).toBe("Process exited with code -1 after signal SIGKILL.");
    });

    // Catches: the counter read as a total rather than a change, so one earlier out-of-memory
    // kill in the cgroup makes every later SIGKILL read as out of memory.
    it("reports a non-zero exit when no out-of-memory kill was counted during the attempt", async () => {
      const error = await killedAfterBaseline(1, 1);

      expect(error.code).toBe("TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE");
    });

    // Catches: the baseline read racing the attempt's dispatch, so a kill right after the
    // attempt starts lands in the baseline and is reported as a non-zero exit.
    it("counts an out-of-memory kill that happens as soon as the attempt starts", async () => {
      const error = await withCgroup(async (cgroup) => {
        await cgroup.writeEvents(0);
        return (await attemptOn(cgroup, OOM_ON_EXECUTE_CHILD)).failure;
      });

      expect(error.code).toBe("TASK_PROCESS_OOM_KILLED");
    });

    // Catches: a child that exits while the attempt waits on the counter rejecting the attempt
    // before anything handles it, an unhandled rejection that can take the controller down, and
    // the exit then being reported as a child that was never connected.
    it("reports a child that exits during a slow counter read as the attempt's error", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const error = await withCgroup(async (cgroup) => {
          // Nothing writes to it, so the read blocks until the test releases it.
          execFileSync("mkfifo", [cgroup.events]);
          try {
            const { proc, failure } = await attemptOn(cgroup, IDLE_CHILD);
            const exited = new Promise((resolve) => proc.onExit.attachOnce(resolve));
            process.kill(proc.pid!, "SIGKILL");
            await exited;
            // Gives Node a turn to report an unhandled rejection while the read is still blocked.
            await new Promise((resolve) => setImmediate(resolve));
            return await failure;
          } finally {
            await releaseReader(cgroup.events);
          }
        });

        expect(error.code).toBe("TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE");
        expect(error.message).toBe("Process exited with code -1 after signal SIGKILL.");
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });
});
