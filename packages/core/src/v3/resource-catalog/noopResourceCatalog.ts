import { QueueManifest, TaskManifest, WorkerManifest } from "../schemas/index.js";
import { TaskMetadataWithFunctions } from "../types/index.js";
import { ResourceCatalog } from "./catalog.js";

export class NoopResourceCatalog implements ResourceCatalog {
  registerTaskMetadata(task: TaskMetadataWithFunctions): void {
    // noop
  }

  setCurrentFileContext(filePath: string, entryPoint: string): void {
    // noop
  }

  clearCurrentFileContext(): void {
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

  registerWorkerManifest(workerManifest: WorkerManifest): void {
    // noop
  }

  registerQueueMetadata(queue: QueueManifest): void {
    // noop
  }

  listQueueManifests(): Array<QueueManifest> {
    return [];
  }
}
