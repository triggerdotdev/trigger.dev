import {
  EventManifest,
  TaskFileMetadata,
  TaskMetadata,
  TaskManifest,
  WorkerManifest,
  QueueManifest,
} from "../schemas/index.js";
import { TaskMetadataWithFunctions, TaskSchema } from "../types/index.js";
import { type EventMetadata, ResourceCatalog } from "./catalog.js";

export class StandardResourceCatalog implements ResourceCatalog {
  private _taskSchemas: Map<string, TaskSchema> = new Map();
  private _taskMetadata: Map<string, TaskMetadata> = new Map();
  private _taskFunctions: Map<string, TaskMetadataWithFunctions["fns"]> = new Map();
  private _taskFileMetadata: Map<string, TaskFileMetadata> = new Map();
  private _currentFileContext?: Omit<TaskFileMetadata, "exportName">;
  private _queueMetadata: Map<string, QueueManifest> = new Map();
  private _eventMetadata: Map<string, EventMetadata> = new Map();
  private _eventToTasks: Map<string, Set<string>> = new Map();

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

    this._taskFileMetadata.set(task.id, {
      ...this._currentFileContext,
    });

    this._taskMetadata.set(task.id, metadata);
    this._taskFunctions.set(task.id, fns);

    if (schema) {
      this._taskSchemas.set(task.id, schema);
    }

    // Register event→task reverse index if task subscribes to an event
    if (metadata.onEvent) {
      this.registerTaskMetadataForEvent(task.id, metadata.onEvent);
    }
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

      const taskManifest = {
        ...metadata,
        ...fileMetadata,
      };

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

  registerEventMetadata(event: EventMetadata): void {
    this._eventMetadata.set(event.id, event);
  }

  getEvent(id: string): EventMetadata | undefined {
    return this._eventMetadata.get(id);
  }

  getEventSchema(id: string): unknown | undefined {
    return this._eventMetadata.get(id)?.rawSchema;
  }

  listEventManifests(): Array<EventManifest> {
    return Array.from(this._eventMetadata.values()).map((event) => ({
      id: event.id,
      version: event.version,
      description: event.description,
      rateLimit: event.rateLimit,
      ordering: event.ordering,
    }));
  }

  getTasksForEvent(eventId: string): Array<TaskMetadataWithFunctions> {
    const taskIds = this._eventToTasks.get(eventId);
    if (!taskIds) {
      return [];
    }

    const tasks: Array<TaskMetadataWithFunctions> = [];
    for (const taskId of taskIds) {
      const task = this.getTask(taskId);
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  registerTaskMetadataForEvent(taskId: string, eventId: string): void {
    let taskSet = this._eventToTasks.get(eventId);
    if (!taskSet) {
      taskSet = new Set();
      this._eventToTasks.set(eventId, taskSet);
    }
    taskSet.add(taskId);
  }

  disable() {
    // noop
  }
}
