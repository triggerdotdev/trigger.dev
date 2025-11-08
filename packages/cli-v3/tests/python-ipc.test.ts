import { describe, it, expect } from "vitest";
import { PythonProcess } from "../src/python/pythonProcess.js";
import path from "path";
import { fileURLToPath } from "url";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Python IPC", () => {
  it("can spawn Python worker and communicate", async () => {
    const indexWorker = path.join(__dirname, "../src/entryPoints/python/managed-index-worker.py");

    const manifestPath = path.join(__dirname, "fixtures/test-manifest.json");

    const pythonProcess = new PythonProcess({
      workerScript: indexWorker,
      env: {
        TRIGGER_MANIFEST_PATH: manifestPath,
        PYTHONPATH: path.join(__dirname, "../../python-sdk"),
      },
    });

    const ipc = await pythonProcess.start();

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);

      ipc.on("INDEX_TASKS_COMPLETE", (message: any) => {
        clearTimeout(timeout);
        resolve(message);
      });

      ipc.on("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ipc.on("exit", (code: number | null) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });

    expect(result).toHaveProperty("tasks");
    expect((result as any).tasks.length).toBeGreaterThan(0);

    await pythonProcess.cleanup();
  });

  it("can execute Python task end-to-end", async () => {
    const runWorker = path.join(__dirname, "../src/entryPoints/python/managed-run-worker.py");

    const pythonProcess = new PythonProcess({
      workerScript: runWorker,
      env: {
        PYTHONPATH: path.join(__dirname, "../../python-sdk"),
      },
    });

    const ipc = await pythonProcess.start();

    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);

      ipc.on("TASK_RUN_COMPLETED", (message: any) => {
        clearTimeout(timeout);
        resolve(message);
      });

      ipc.on("TASK_RUN_FAILED_TO_RUN", (message: any) => {
        clearTimeout(timeout);
        reject(new Error(`Task failed: ${message.completion.error.message}`));
      });

      ipc.on("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      // Send execution message
      ipc.send({
        type: "EXECUTE_TASK_RUN",
        version: "v1",
        execution: {
          task: {
            id: "test-python-task",
            filePath: path.join(__dirname, "python/test-task.py"),
            exportName: "test-python-task",
          },
          run: {
            id: "run_test123",
            payload: JSON.stringify({ name: "Test" }),
            payloadType: "application/json",
            context: {},
            tags: [],
            isTest: true,
          },
          attempt: {
            id: "attempt_test123",
            number: 1,
            startedAt: new Date().toISOString(),
            backgroundWorkerId: "worker_test",
            backgroundWorkerTaskId: "task_test",
          },
        },
      });
    });

    expect(result.type).toBe("TASK_RUN_COMPLETED");
    expect(result.completion.ok).toBe(true);
    expect(result.completion.output).toContain("Hello");

    await pythonProcess.cleanup();
  });
});
