import { TaskMetadataWithFilePath, TaskRun, WorkerMessages } from "./dev/schemas";
import { TaskMetadataWithRun } from "./types";

type TaskFileImport = Record<string, unknown>;

const TaskFileImports: Record<string, TaskFileImport> = {};
const TaskFiles: Record<string, string> = {};

__TASKS__;
declare const __TASKS__: Record<string, string>;

class TaskExecutor {
  constructor(public task: TaskMetadataWithRun) {}

  async execute(taskRun: TaskRun) {
    const parsedPayload = JSON.parse(taskRun.payload);

    const output = await this.task.run({ payload: parsedPayload });

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

const tasks = getTasks();

const taskExecutors: Map<string, TaskExecutor> = new Map();

for (const task of tasks) {
  taskExecutors.set(task.id, new TaskExecutor(task));
}

process.on("message", async (msg: any) => {
  const message = WorkerMessages.safeParse(msg);

  if (!message.success) {
    console.log("Received invalid message", { rawMessage: msg });
    return;
  }

  switch (message.data.type) {
    case "EXECUTE_TASK_RUN": {
      const executor = taskExecutors.get(msg.taskRun.taskIdentifier);

      if (!executor) {
        console.error(`Could not find executor for task ${msg.taskRun.taskIdentifier}`);

        process.send?.({
          type: "TASK_RUN_COMPLETED",
          result: {
            id: msg.taskRun.id,
            error: "Could not find executor",
          },
        });

        return;
      }

      executor.execute(msg.taskRun).then((result) => {
        process.send?.({
          type: "TASK_RUN_COMPLETED",
          result: {
            id: msg.taskRun.id,
            ...result,
          },
        });
      });

      break;
    }
  }
});

process.send?.({ type: "TASKS_READY", tasks: getTaskMetadata() });

process.title = "trigger-dev-worker";
