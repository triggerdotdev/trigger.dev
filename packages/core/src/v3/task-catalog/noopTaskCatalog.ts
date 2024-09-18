import { TaskFileMetadata, TaskManifest } from "../schemas/index.js";
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

  listTaskManifests(): Array<TaskManifest> {
    return [];
  }

  getTaskManifest(id: string): TaskManifest | undefined {
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
