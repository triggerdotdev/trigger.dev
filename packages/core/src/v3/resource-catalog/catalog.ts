import { QueueManifest, TaskManifest, WorkerManifest } from "../schemas/index.js";
import { TaskMetadataWithFunctions } from "../types/index.js";

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
}
