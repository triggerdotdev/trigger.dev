import { TaskFileMetadata, TaskMetadataWithFilePath } from "../schemas";
import { TaskMetadataWithFunctions } from "../types";
import { TaskCatalog } from "./catalog";

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

  disable() {
    // noop
  }
}
