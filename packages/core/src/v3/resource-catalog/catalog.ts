import { PromptManifest, QueueManifest, TaskManifest, WorkerManifest } from "../schemas/index.js";
import { PromptMetadataWithFunctions, TaskMetadataWithFunctions, TaskSchema } from "../types/index.js";

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
  registerPromptMetadata(prompt: PromptMetadataWithFunctions): void;
  listPromptManifests(): Array<PromptManifest>;
  getPrompt(id: string): PromptMetadataWithFunctions | undefined;
  getPromptSchema(id: string): TaskSchema | undefined;
}
