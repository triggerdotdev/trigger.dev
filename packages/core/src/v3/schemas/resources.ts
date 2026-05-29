import { z } from "zod";
import { QueueManifest, RetryOptions, ScheduleMetadata } from "./schemas.js";
import { MachineConfig } from "./common.js";

export const AgentConfig = z.object({
  type: z.string(), // "ai-sdk-chat" initially, extensible for future agent types
});

export type AgentConfig = z.infer<typeof AgentConfig>;

export const TaskResource = z.object({
  id: z.string(),
  description: z.string().optional(),
  filePath: z.string(),
  exportName: z.string().optional(),
  queue: QueueManifest.extend({ name: z.string().optional() }).optional(),
  retry: RetryOptions.optional(),
  machine: MachineConfig.optional(),
  triggerSource: z.string().optional(),
  agentConfig: AgentConfig.optional(),
  schedule: ScheduleMetadata.optional(),
  maxDuration: z.number().optional(),
  ttl: z.string().or(z.number().nonnegative().int()).optional(),
  // JSONSchema type - using z.unknown() for runtime validation to accept JSONSchema7
  payloadSchema: z.unknown().optional(),
});

export type TaskResource = z.infer<typeof TaskResource>;

export const BackgroundWorkerSourceFileMetadata = z.object({
  filePath: z.string(),
  contents: z.string(),
  contentHash: z.string(),
  taskIds: z.array(z.string()),
});

export type BackgroundWorkerSourceFileMetadata = z.infer<typeof BackgroundWorkerSourceFileMetadata>;

export const PromptResource = z.object({
  id: z.string(),
  description: z.string().optional(),
  filePath: z.string(),
  exportName: z.string().optional(),
  /** The default template content */
  content: z.string().optional(),
  /** Default model identifier */
  model: z.string().optional(),
  /** Default model config (temperature, maxTokens, etc.) */
  config: z.record(z.unknown()).optional(),
  /** JSONSchema7 for template variables */
  variableSchema: z.unknown().optional(),
});

export type PromptResource = z.infer<typeof PromptResource>;

export const BackgroundWorkerMetadata = z.object({
  packageVersion: z.string(),
  contentHash: z.string(),
  cliPackageVersion: z.string().optional(),
  tasks: z.array(TaskResource),
  prompts: z.array(PromptResource).optional(),
  queues: z.array(QueueManifest).optional(),
  sourceFiles: z.array(BackgroundWorkerSourceFileMetadata).optional(),
  runtime: z.string().optional(),
  runtimeVersion: z.string().optional(),
});

export type BackgroundWorkerMetadata = z.infer<typeof BackgroundWorkerMetadata>;

export const ImageDetailsMetadata = z.object({
  contentHash: z.string(),
  imageTag: z.string(),
});

export type ImageDetailsMetadata = z.infer<typeof ImageDetailsMetadata>;
