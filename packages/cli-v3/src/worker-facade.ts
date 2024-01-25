import {
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunErrorCodes,
  TaskRunExecution,
  ZodMessageHandler,
  ZodMessageSender,
  childToWorkerMessages,
  parseError,
  workerToChildMessages,
} from "@trigger.dev/core/v3";
import { TaskMetadataWithRun } from "./types.js";

type TaskFileImport = Record<string, unknown>;

const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<string, string> = {};

__TASKS__;
declare const __TASKS__: Record<string, string>;

class TaskExecutor {
  constructor(public task: TaskMetadataWithRun) {}

  async execute(execution: TaskRunExecution) {
    const parsedPayload = JSON.parse(execution.run.payload);

    const output = await this.task.run({
      payload: parsedPayload,
      context: TaskRunContext.parse(execution),
    });

    return { output: JSON.stringify(output), outputType: "application/json" };
  }
}

function getTasks(): Array<TaskMetadataWithRun> {
  const result: Array<TaskMetadataWithRun> = [];

  for (const [importName, taskFile] of Object.entries(TaskFiles)) {
    const fileImports = TaskFileImports[importName];

    for (const [exportName, task] of Object.entries(fileImports ?? {})) {
      if ((task as any).__trigger) {
        result.push({
          id: (task as any).__trigger.id,
          exportName,
          packageVersion: (task as any).__trigger.packageVersion,
          filePath: (taskFile as any).filePath,
          run: (task as any).__trigger.run,
        });
      }
    }
  }

  return result;
}

function getTaskMetadata(): Array<TaskMetadataWithFilePath> {
  const result = getTasks();

  // Remove the run function from the metadata
  return result.map((task) => {
    const { run, ...metadata } = task;

    return metadata;
  });
}

const sender = new ZodMessageSender({
  schema: childToWorkerMessages,
  sender: async (message) => {
    process.send?.(message);
  },
});

const tasks = getTasks();

const taskExecutors: Map<string, TaskExecutor> = new Map();

for (const task of tasks) {
  taskExecutors.set(task.id, new TaskExecutor(task));
}

const handler = new ZodMessageHandler({
  schema: workerToChildMessages,
  messages: {
    EXECUTE_TASK_RUN: async (payload) => {
      const executor = taskExecutors.get(payload.task.id);

      if (!executor) {
        console.error(`Could not find executor for task ${payload.task.id}`);

        await sender.send("TASK_RUN_COMPLETED", {
          ok: false,
          id: payload.attempt.id,
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.COULD_NOT_FIND_EXECUTOR,
          },
        });

        return;
      }

      try {
        const result = await executor.execute(payload);

        return sender.send("TASK_RUN_COMPLETED", {
          id: payload.attempt.id,
          ok: true,
          ...result,
        });
      } catch (e) {
        return sender.send("TASK_RUN_COMPLETED", {
          id: payload.attempt.id,
          ok: false,
          error: parseError(e),
        });
      }
    },
  },
});

process.on("message", async (msg: any) => {
  await handler.handleMessage(msg);
});

sender.send("TASKS_READY", getTaskMetadata()).catch((err) => {
  console.error("Failed to send TASKS_READY message", err);
});

process.title = "trigger-dev-worker";
