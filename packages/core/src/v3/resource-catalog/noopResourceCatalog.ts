import type {
  PromptManifest,
  QueueManifest,
  SkillManifest,
  SkillMetadata,
  TaskManifest,
  WorkerManifest,
} from "../schemas/index.js";
import {
  type PromptMetadataWithFunctions,
  type TaskMetadataWithFunctions,
  type TaskSchema,
} from "../types/index.js";
import type { ResourceCatalog } from "./catalog.js";

export class NoopResourceCatalog implements ResourceCatalog {
  registerTaskMetadata(_task: TaskMetadataWithFunctions): void {
    // noop
  }

  setCurrentFileContext(_filePath: string, _entryPoint: string): void {
    // noop
  }

  clearCurrentFileContext(): void {
    // noop
  }

  updateTaskMetadata(_id: string, _updates: Partial<TaskMetadataWithFunctions>): void {
    // noop
  }

  listTaskManifests(): Array<TaskManifest> {
    return [];
  }

  listTaskIdCollisions(): Array<{ id: string; filePaths: string[] }> {
    return [];
  }

  getTaskManifest(_id: string): TaskManifest | undefined {
    return undefined;
  }

  getTask(_id: string): TaskMetadataWithFunctions | undefined {
    return undefined;
  }

  getTaskSchema(_id: string): TaskSchema | undefined {
    return undefined;
  }

  taskExists(_id: string): boolean {
    return false;
  }

  disable() {
    // noop
  }

  registerWorkerManifest(_workerManifest: WorkerManifest): void {
    // noop
  }

  registerQueueMetadata(_queue: QueueManifest): void {
    // noop
  }

  listQueueManifests(): Array<QueueManifest> {
    return [];
  }

  registerPromptMetadata(_prompt: PromptMetadataWithFunctions): void {
    // noop
  }

  listPromptManifests(): Array<PromptManifest> {
    return [];
  }

  getPrompt(_id: string): PromptMetadataWithFunctions | undefined {
    return undefined;
  }

  getPromptSchema(_id: string): TaskSchema | undefined {
    return undefined;
  }

  registerSkillMetadata(_skill: SkillMetadata): void {
    // noop
  }

  listSkillManifests(): Array<SkillManifest> {
    return [];
  }

  getSkillManifest(_id: string): SkillManifest | undefined {
    return undefined;
  }
}
