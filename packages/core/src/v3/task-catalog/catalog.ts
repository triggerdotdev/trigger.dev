import { TaskFileMetadata, TaskManifest } from "../schemas/index.js";
import { TaskMetadataWithFunctions } from "../types/index.js";

export interface TaskCatalog {
  registerTaskMetadata(task: TaskMetadataWithFunctions): void;
  updateTaskMetadata(id: string, task: Partial<TaskMetadataWithFunctions>): void;
  registerTaskFileMetadata(id: string, metadata: TaskFileMetadata): void;
  listTaskManifests(): Array<TaskManifest>;
  getTaskManifest(id: string): TaskManifest | undefined;
  getTask(id: string): TaskMetadataWithFunctions | undefined;
  taskExists(id: string): boolean;
}
