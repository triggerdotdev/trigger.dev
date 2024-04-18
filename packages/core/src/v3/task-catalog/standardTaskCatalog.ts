import { TaskFileMetadata, TaskMetadata, TaskMetadataWithFilePath } from "../schemas";
import { TaskMetadataWithFunctions } from "../types";
import { TaskCatalog } from "./catalog";

export class StandardTaskCatalog implements TaskCatalog {
  private _taskMetadata: Map<string, TaskMetadata> = new Map();
  private _taskFunctions: Map<string, TaskMetadataWithFunctions["fns"]> = new Map();
  private _taskFileMetadata: Map<string, TaskFileMetadata> = new Map();

  registerTaskMetadata(task: TaskMetadataWithFunctions): void {
    const { fns, ...metadata } = task;

    this._taskMetadata.set(task.id, metadata);
    this._taskFunctions.set(task.id, fns);
  }

  updateTaskMetadata(id: string, updates: Partial<TaskMetadataWithFunctions>): void {
    const existingMetadata = this._taskMetadata.get(id);

    if (existingMetadata) {
      this._taskMetadata.set(id, {
        ...existingMetadata,
        ...updates,
      });
    }

    if (updates.fns) {
      const existingFunctions = this._taskFunctions.get(id);

      if (existingFunctions) {
        this._taskFunctions.set(id, {
          ...existingFunctions,
          ...updates.fns,
        });
      }
    }
  }

  registerTaskFileMetadata(id: string, metadata: TaskFileMetadata): void {
    this._taskFileMetadata.set(id, metadata);
  }

  // Return all the tasks, without the functions
  getAllTaskMetadata(): Array<TaskMetadataWithFilePath> {
    const result: Array<TaskMetadataWithFilePath> = [];

    for (const [id, metadata] of this._taskMetadata) {
      const fileMetadata = this._taskFileMetadata.get(id);

      if (!fileMetadata) {
        continue;
      }

      result.push({
        ...metadata,
        ...fileMetadata,
      });
    }

    return result;
  }

  getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined {
    const metadata = this._taskMetadata.get(id);
    const fileMetadata = this._taskFileMetadata.get(id);

    if (!metadata || !fileMetadata) {
      return undefined;
    }

    return {
      ...metadata,
      ...fileMetadata,
    };
  }

  getTask(id: string): TaskMetadataWithFunctions | undefined {
    const metadata = this._taskMetadata.get(id);
    const fileMetadata = this._taskFileMetadata.get(id);
    const fns = this._taskFunctions.get(id);

    if (!metadata || !fns || !fileMetadata) {
      return undefined;
    }

    return {
      ...metadata,
      ...fileMetadata,
      fns,
    };
  }

  disable() {
    // noop
  }
}
