import { TaskFileMetadata, TaskMetadataWithFilePath } from "../schemas";
import { TaskMetadataWithFunctions } from "../types";

export interface TaskCatalog {
  registerTaskMetadata(task: TaskMetadataWithFunctions): void;
  updateTaskMetadata(id: string, task: Partial<TaskMetadataWithFunctions>): void;
  registerTaskFileMetadata(id: string, metadata: TaskFileMetadata): void;
  getAllTaskMetadata(): Array<TaskMetadataWithFilePath>;
  getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined;
  getTask(id: string): TaskMetadataWithFunctions | undefined;
  taskExists(id: string): boolean;
}
