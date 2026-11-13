import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachinePresetResources, WorkerManifest } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { TaskRunProcessPool } from "./taskRunProcessPool.js";

describe("TaskRunProcessPool", () => {
  // Catches: dev task processes counting out-of-memory kills in the cgroup they share, so one
  // task's kill would fail another task's unrelated SIGKILL as out of memory.
  it("creates task processes without out-of-memory kill detection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-run-process-pool-"));
    const pool = new TaskRunProcessPool({ env: {}, cwd: dir, enableProcessReuse: false });
    let pid: number | undefined;
    try {
      const entryPoint = join(dir, "child.mjs");
      await writeFile(entryPoint, "setInterval(() => {}, 1000);\n");
      const { taskRunProcess } = await pool.getProcess(
        {
          runtime: "node",
          workerEntryPoint: entryPoint,
          configEntryPoint: entryPoint,
          otelImportHook: {},
        } as unknown as WorkerManifest,
        { id: "worker-1", version: "1", contentHash: "hash" },
        { cpu: 1, memory: 1 } as MachinePresetResources
      );

      pid = taskRunProcess.pid;

      expect(taskRunProcess.options.oomKillCounter).toBeUndefined();
    } finally {
      if (pid) process.kill(pid, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
