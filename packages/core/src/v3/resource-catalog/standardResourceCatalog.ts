import {
  TaskFileMetadata,
  TaskMetadata,
  TaskManifest,
  WorkerManifest,
  QueueManifest,
} from "../schemas/index.js";
import { TaskMetadataWithFunctions } from "../types/index.js";
import { ResourceCatalog } from "./catalog.js";

export class StandardResourceCatalog implements ResourceCatalog {
  private _taskMetadata: Map<string, TaskMetadata> = new Map();
  private _taskFunctions: Map<string, TaskMetadataWithFunctions["fns"]> = new Map();
  private _taskFileMetadata: Map<string, TaskFileMetadata> = new Map();
  private _currentFileContext?: Omit<TaskFileMetadata, "exportName">;
  private _queueMetadata: Map<string, QueueManifest> = new Map();

  setCurrentFileContext(filePath: string, entryPoint: string) {
    this._currentFileContext = { filePath, entryPoint };
  }

  clearCurrentFileContext() {
    this._currentFileContext = undefined;
  }

  registerQueueMetadata(queue: QueueManifest): void {
    this._queueMetadata.set(queue.name, queue);
  }

  registerWorkerManifest(workerManifest: WorkerManifest): void {
    for (const task of workerManifest.tasks) {
      this._taskFileMetadata.set(task.id, {
        filePath: task.filePath,
        entryPoint: task.entryPoint,
      });
    }
  }

  registerTaskMetadata(task: TaskMetadataWithFunctions): void {
    if (!this._currentFileContext) {
      return;
    }

    const { fns, ...metadata } = task;

    if (!task.id) {
      return;
    }

    this._taskFileMetadata.set(task.id, {
      ...this._currentFileContext,
    });

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

  // Return all the tasks, without the functions
  listTaskManifests(): Array<TaskManifest> {
    const result: Array<TaskManifest> = [];

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

  listQueueManifests(): Array<QueueManifest> {
    return Array.from(this._queueMetadata.values());
  }

  getTaskManifest(id: string): TaskManifest | undefined {
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

  taskExists(id: string): boolean {
    return this._taskMetadata.has(id);
  }

  disable() {
    // noop
  }
}
