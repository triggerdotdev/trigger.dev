import { TaskMetadata } from "./types";

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
    }
  }

  return tasks;
}

process.on("message", (msg: any) => {
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
    }
  }
});

process.send?.({ serverReady: true });
