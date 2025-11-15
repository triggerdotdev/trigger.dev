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

/**
 * Convert protobuf completion message (snake_case) to TypeScript result (camelCase)
 */
function protoCompletionToResult(
  completion: any,
  runId: string,
  isSuccess: boolean
): TaskRunExecutionResult {
  if (isSuccess) {
    return {
      ok: true,
      id: runId,
      output: completion.output,
      outputType: completion.output_type || "application/json",
      usage: {
        durationMs: parseInt(completion.usage?.duration_ms || "0"),
      },
    };
  } else {
    return {
      ok: false,
      id: runId,
      error: completion.error,
      usage: {
        durationMs: parseInt(completion.usage?.duration_ms || "0"),
      },
    };
  }
}

/**
 * Convert TypeScript execution (camelCase) to protobuf message (snake_case)
 */
function executionToProtoMessage(execution: TaskRunExecution) {
  return {
    execute_task_run: {
      type: "EXECUTE_TASK_RUN",
      version: "v1",
      execution: {
        task: {
          id: execution.task.id,
          file_path: execution.task.filePath,
        },
        run: {
          id: execution.run.id,
          payload: JSON.stringify(execution.run.payload), // CRITICAL: Must be JSON string
          payload_type: execution.run.payloadType || "application/json",
          tags: execution.run.tags || [],
          is_test: execution.run.isTest || false,
        },
        attempt: {
          id: String(execution.attempt.id),
          number: execution.attempt.number,
          started_at: execution.attempt.startedAt?.toISOString() || new Date().toISOString(),
        },
      },
    },
  };
}

export class PythonTaskRunner {
  async executeTask(execution: TaskRunExecution): Promise<TaskRunExecutionResult> {
    const workerScript = path.join(__dirname, "../entryPoints/python/managed-run-worker.py");

    // Determine PYTHONPATH - use env var if set, otherwise use relative path for dev
    const pythonPath = process.env.TRIGGER_PYTHON_SDK_PATH
      ? process.env.TRIGGER_PYTHON_SDK_PATH
      : path.join(__dirname, "../../../../python-sdk");

    const pythonProcess = new PythonProcess({
      workerScript,
      env: {
        TRIGGER_MANIFEST_PATH: process.env.TRIGGER_WORKER_MANIFEST_PATH || "",
        // Add SDK path for dev mode (in production, SDK is installed via pip)
        ...(process.env.TRIGGER_PYTHON_SDK_PATH || process.env.NODE_ENV !== "production"
          ? { PYTHONPATH: pythonPath }
          : {}),
        // Add trace context, env vars, etc.
      },
    });

    try {
      const grpcServer = await pythonProcess.start();

      // Wait for worker to connect
      const connectionId = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Worker failed to connect via gRPC"));
        }, 10000);

        grpcServer.once("connection", (connId: string) => {
          clearTimeout(timeout);
          logger.debug("Python worker connected", { connectionId: connId });
          resolve(connId);
        });
      });

      // Wait for completion or failure
      const result = await new Promise<TaskRunExecutionResult>((resolve, reject) => {
        // execution.run.maxDuration is in SECONDS from the platform, convert to milliseconds
        const maxDurationMs = execution.run.maxDuration
          ? execution.run.maxDuration * 1000
          : 300000;
        logger.debug(`Setting task timeout to ${maxDurationMs}ms (${maxDurationMs/1000}s)`, {
          maxDuration: execution.run.maxDuration,
          runId: execution.run.id,
        });
        const timeout = setTimeout(() => {
          reject(new Error("Task execution timeout"));
        }, maxDurationMs);

        grpcServer.on("TASK_RUN_COMPLETED", (message: any) => {
          clearTimeout(timeout);
          resolve(protoCompletionToResult(message.completion, execution.run.id, true));
        });

        grpcServer.on("TASK_RUN_FAILED_TO_RUN", (message: any) => {
          clearTimeout(timeout);
          resolve(protoCompletionToResult(message.completion, execution.run.id, false));
        });

        grpcServer.on("TASK_HEARTBEAT", () => {
          logger.debug("Received heartbeat from Python task");
        });

        // Send execution message via gRPC
        grpcServer.sendToWorker(connectionId, executionToProtoMessage(execution));
      });

      return result;
    } finally {
      await pythonProcess.cleanup();
    }
  }
}
