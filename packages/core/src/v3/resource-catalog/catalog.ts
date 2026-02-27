import { EventManifest, QueueManifest, TaskManifest, WorkerManifest } from "../schemas/index.js";
import { TaskMetadataWithFunctions, TaskSchema } from "../types/index.js";

export interface EventMetadata {
  id: string;
  version: string;
  description?: string;
}

export interface ResourceCatalog {
  setCurrentFileContext(filePath: string, entryPoint: string): void;
  clearCurrentFileContext(): void;
  registerTaskMetadata(task: TaskMetadataWithFunctions): void;
  updateTaskMetadata(id: string, task: Partial<TaskMetadataWithFunctions>): void;
  listTaskManifests(): Array<TaskManifest>;
  getTaskManifest(id: string): TaskManifest | undefined;
  getTask(id: string): TaskMetadataWithFunctions | undefined;
  taskExists(id: string): boolean;
  registerWorkerManifest(workerManifest: WorkerManifest): void;
  registerQueueMetadata(queue: QueueManifest): void;
  listQueueManifests(): Array<QueueManifest>;
  getTaskSchema(id: string): TaskSchema | undefined;
  registerEventMetadata(event: EventMetadata): void;
  getEvent(id: string): EventMetadata | undefined;
  listEventManifests(): Array<EventManifest>;
  getTasksForEvent(eventId: string): Array<TaskMetadataWithFunctions>;
}
