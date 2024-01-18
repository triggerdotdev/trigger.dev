import { TaskMetadata } from "./types";

type TaskRun = {
  id: string;
  payload: string;
  payloadType: string;
  context?: any;
};

class TaskExecutor {
  constructor(
    public id: string,
    public runFunc: (params: any) => Promise<any>
  ) {}

  async execute(taskRun: TaskRun) {
    const parsedPayload = JSON.parse(taskRun.payload);

    const output = await this.runFunc({ payload: parsedPayload });

    return { output: JSON.stringify(output), outputType: "application/json" };
  }
}

const taskExecutors: Map<string, TaskExecutor> = new Map();

async function loadEntryPoint(path: string, exports: string[]): Promise<Array<TaskMetadata>> {
  const tasks: Array<TaskMetadata> = [];

  const taskModule = await import(path);

  for (const exportName of exports) {
    const task = taskModule[exportName];

    if (!task) {
      throw new Error(`Could not find task ${exportName} in ${path}`);
    }

    if (task.__trigger) {
      tasks.push({
        id: task.__trigger.id,
        exportName,
        packageVersion: task.__trigger.packageVersion,
      });

      taskExecutors.set(task.__trigger.id, new TaskExecutor(task.__trigger.id, task.__trigger.run));
    }
  }

  return tasks;
}

process.on("message", async (msg: any) => {
  if (msg && typeof msg === "object") {
    if (msg.entryPoint) {
      loadEntryPoint(msg.entryPoint.path, msg.entryPoint.exports)
        .then((tasks) => {
          process.send?.({ tasksReady: true, tasks });
        })
        .catch((err) => {
          console.error(err);
          process.exit();
        });
    } else if (typeof msg.taskRun === "object") {
      const executor = taskExecutors.get(msg.taskRun.taskIdentifier);

      if (!executor) {
        console.error(`Could not find executor for task ${msg.taskRun.taskIdentifier}`);

        process.send?.({
          taskRunCompleted: true,
          result: {
            id: msg.taskRun.id,
            error: "Could not find executor",
          },
        });

        return;
      }

      executor.execute(msg.taskRun).then((result) => {
        process.send?.({
          taskRunCompleted: true,
          result: {
            id: msg.taskRun.id,
            ...result,
          },
        });
      });
    }
  }
});

process.send?.({ serverReady: true });
