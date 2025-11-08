/**
 * High-level Python task execution.
 *
 * Manages Python worker lifecycle for task execution.
 */

import path from "path";
import { fileURLToPath } from "url";
import { PythonProcess } from "./pythonProcess.js";
import { TaskRunExecution, TaskRunExecutionResult } from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class PythonTaskRunner {
  async executeTask(execution: TaskRunExecution): Promise<TaskRunExecutionResult> {
    const workerScript = path.join(__dirname, "../entryPoints/python/managed-run-worker.py");

    const pythonProcess = new PythonProcess({
      workerScript,
      env: {
        TRIGGER_MANIFEST_PATH: execution.worker.manifestPath,
        // Add SDK path for dev mode (assumes SDK is in packages/python-sdk)
        PYTHONPATH: path.join(__dirname, "../../../python-sdk"),
        // Add trace context, env vars, etc.
      },
    });

    try {
      const ipc = await pythonProcess.start();

      // Wait for completion or failure
      const result = await new Promise<TaskRunExecutionResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Task execution timeout"));
        }, execution.task.maxDuration ?? 300000);

        ipc.on("TASK_RUN_COMPLETED", (message: any) => {
          clearTimeout(timeout);
          resolve({
            ok: true,
            output: message.completion.output,
            outputType: message.completion.outputType,
            usage: message.completion.usage,
          });
        });

        ipc.on("TASK_RUN_FAILED_TO_RUN", (message: any) => {
          clearTimeout(timeout);
          resolve({
            ok: false,
            error: message.completion.error,
            usage: message.completion.usage,
          });
        });

        ipc.on("TASK_HEARTBEAT", () => {
          logger.debug("Received heartbeat from Python task");
        });

        ipc.on("exit", (code: number | null) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Python worker exited with code ${code}`));
          }
        });

        // Send execution message
        ipc.send({
          type: "EXECUTE_TASK_RUN",
          version: "v1",
          execution: {
            task: {
              id: execution.task.id,
              filePath: execution.task.filePath,
              exportName: execution.task.exportName,
            },
            run: {
              id: execution.run.id,
              payload: JSON.stringify(execution.run.payload), // CRITICAL: Must be JSON string
              payloadType: execution.run.payloadType,
              context: execution.run.context,
              tags: execution.run.tags,
              isTest: execution.run.isTest,
            },
            attempt: {
              id: execution.attempt.id,
              number: execution.attempt.number,
              startedAt: execution.attempt.startedAt,
              backgroundWorkerId: execution.attempt.backgroundWorkerId,
              backgroundWorkerTaskId: execution.attempt.backgroundWorkerTaskId,
            },
          },
        });
      });

      return result;
    } finally {
      await pythonProcess.cleanup();
    }
  }
}
