import { TaskFileMetadata, TaskMetadataWithFilePath } from "../schemas/index.js";
import { TaskMetadataWithFunctions } from "../types/index.js";
import { TaskCatalog } from "./catalog.js";

export class NoopTaskCatalog implements TaskCatalog {
  registerTaskMetadata(task: TaskMetadataWithFunctions): void {
    // noop
  }

  registerTaskFileMetadata(id: string, metadata: TaskFileMetadata): void {
    // noop
  }

  updateTaskMetadata(id: string, updates: Partial<TaskMetadataWithFunctions>): void {
    // noop
  }

  getAllTaskMetadata(): Array<TaskMetadataWithFilePath> {
    return [];
  }

  getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined {
    return undefined;
  }

  getTask(id: string): TaskMetadataWithFunctions | undefined {
    return undefined;
  }

  taskExists(id: string): boolean {
    return false;
  }

  disable() {
    // noop
  }
}
