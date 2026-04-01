import { trail } from "agentcrumbs"; // @crumbs
const _coreCrumb = trail("core"); // @crumbs
import {
  PromptManifest,
  PromptMetadata,
  TaskFileMetadata,
  TaskMetadata,
  TaskManifest,
  WorkerManifest,
  QueueManifest,
} from "../schemas/index.js";
import { PromptMetadataWithFunctions, TaskMetadataWithFunctions, TaskSchema } from "../types/index.js";
import { ResourceCatalog } from "./catalog.js";

export class StandardResourceCatalog implements ResourceCatalog {
  private _taskSchemas: Map<string, TaskSchema> = new Map();
  private _taskMetadata: Map<string, TaskMetadata> = new Map();
  private _taskFunctions: Map<string, TaskMetadataWithFunctions["fns"]> = new Map();
  private _taskFileMetadata: Map<string, TaskFileMetadata> = new Map();
  private _promptMetadata: Map<string, PromptMetadata> = new Map();
  private _promptFunctions: Map<string, PromptMetadataWithFunctions["fns"]> = new Map();
  private _promptFileMetadata: Map<string, TaskFileMetadata> = new Map();
  private _promptSchemas: Map<string, TaskSchema> = new Map();
  private _currentFileContext?: Omit<TaskFileMetadata, "exportName">;
  private _queueMetadata: Map<string, QueueManifest> = new Map();

  setCurrentFileContext(filePath: string, entryPoint: string) {
    this._currentFileContext = { filePath, entryPoint };
  }

  clearCurrentFileContext() {
    this._currentFileContext = undefined;
  }

  registerQueueMetadata(queue: QueueManifest): void {
    const existingQueue = this._queueMetadata.get(queue.name);

    //if it exists already AND concurrencyLimit is different, log a warning
    if (existingQueue) {
      const isConcurrencyLimitDifferent = existingQueue.concurrencyLimit !== queue.concurrencyLimit;

      if (isConcurrencyLimitDifferent) {
        let message = `Queue "${queue.name}" is defined twice, with different settings.`;
        if (isConcurrencyLimitDifferent) {
          message += `\n        - concurrencyLimit: ${existingQueue.concurrencyLimit} vs ${queue.concurrencyLimit}`;
        }

        message += "\n       Keeping the first definition:";
        message += `\n        - concurrencyLimit: ${existingQueue.concurrencyLimit}`;
        console.warn(message);
        return;
      }
    }

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

    const { fns, schema, ...metadata } = task;

    if (!task.id) {
      return;
    }

    // #region @crumbs
    _coreCrumb("registerTaskMetadata", {
      taskId: task.id,
      triggerSource: metadata.triggerSource,
      agentConfig: metadata.agentConfig,
      metadataKeys: Object.keys(metadata),
    });
    // #endregion @crumbs

    this._taskFileMetadata.set(task.id, {
      ...this._currentFileContext,
    });

    this._taskMetadata.set(task.id, metadata);
    this._taskFunctions.set(task.id, fns);

    if (schema) {
      this._taskSchemas.set(task.id, schema);
    }
  }

  updateTaskMetadata(id: string, updates: Partial<TaskMetadataWithFunctions>): void {
    const { fns, schema, ...metadataUpdates } = updates;

    const existingMetadata = this._taskMetadata.get(id);

    if (existingMetadata && Object.keys(metadataUpdates).length > 0) {
      this._taskMetadata.set(id, {
        ...existingMetadata,
        ...metadataUpdates,
      });
    }

    if (fns) {
      const existingFunctions = this._taskFunctions.get(id);

      if (existingFunctions) {
        this._taskFunctions.set(id, {
          ...existingFunctions,
          ...fns,
        });
      }
    }

    if (schema) {
      this._taskSchemas.set(id, schema);
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

      const taskManifest = {
        ...metadata,
        ...fileMetadata,
      };

      // #region @crumbs
      if (metadata.triggerSource || metadata.agentConfig) {
        _coreCrumb("listTaskManifests building manifest", {
          taskId: id,
          triggerSource: metadata.triggerSource,
          agentConfig: metadata.agentConfig,
          manifestTriggerSource: taskManifest.triggerSource,
          manifestAgentConfig: (taskManifest as any).agentConfig,
        });
      }
      // #endregion @crumbs

      result.push(taskManifest);
    }

    return result;
  }

  getTaskSchema(id: string): TaskSchema | undefined {
    return this._taskSchemas.get(id);
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

  registerPromptMetadata(prompt: PromptMetadataWithFunctions): void {
    if (!this._currentFileContext) {
      return;
    }

    const { fns, schema, ...metadata } = prompt;

    if (!prompt.id) {
      return;
    }

    this._promptFileMetadata.set(prompt.id, {
      ...this._currentFileContext,
    });

    this._promptMetadata.set(prompt.id, metadata);
    this._promptFunctions.set(prompt.id, fns);

    if (schema) {
      this._promptSchemas.set(prompt.id, schema);
    }
  }

  getPromptSchema(id: string): TaskSchema | undefined {
    return this._promptSchemas.get(id);
  }

  listPromptManifests(): Array<PromptManifest> {
    const result: Array<PromptManifest> = [];

    for (const [id, metadata] of this._promptMetadata) {
      const fileMetadata = this._promptFileMetadata.get(id);

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

  getPrompt(id: string): PromptMetadataWithFunctions | undefined {
    const metadata = this._promptMetadata.get(id);
    const fileMetadata = this._promptFileMetadata.get(id);
    const fns = this._promptFunctions.get(id);

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
