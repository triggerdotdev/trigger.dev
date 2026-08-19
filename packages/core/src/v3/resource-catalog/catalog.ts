import type {
  PromptManifest,
  QueueManifest,
  SkillManifest,
  SkillMetadata,
  TaskManifest,
  WebhookManifest,
  WebhookMetadata,
  WorkerManifest,
} from "../schemas/index.js";
import type {
  PromptMetadataWithFunctions,
  TaskMetadataWithFunctions,
  TaskSchema,
} from "../types/index.js";

export interface ResourceCatalog {
  setCurrentFileContext(filePath: string, entryPoint: string): void;
  clearCurrentFileContext(): void;
  registerTaskMetadata(task: TaskMetadataWithFunctions): void;
  updateTaskMetadata(id: string, task: Partial<TaskMetadataWithFunctions>): void;
  listTaskManifests(): Array<TaskManifest>;
  listTaskIdCollisions(): Array<{ id: string; filePaths: string[] }>;
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
  registerSkillMetadata(skill: SkillMetadata): void;
  listSkillManifests(): Array<SkillManifest>;
  getSkillManifest(id: string): SkillManifest | undefined;
  registerWebhookMetadata(webhook: WebhookMetadata): void;
  listWebhookManifests(): Array<WebhookManifest>;
  getWebhookManifest(id: string): WebhookManifest | undefined;
  listWebhookIdCollisions(): Array<{ id: string; filePaths: string[] }>;
  // session.webhook descriptors that were declared vs claimed by an agent's `webhooks: [...]`. A
  // declared-but-unclaimed descriptor routes nothing, so the indexer surfaces it (fail loud).
  registerDeclaredSessionWebhook(id: string): void;
  markSessionWebhookClaimed(id: string): void;
  listUnclaimedSessionWebhooks(): Array<string>;
}
