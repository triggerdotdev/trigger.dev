import { z } from "zod";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { MinimalAuthenticatedEnvironment } from "../shared/index.js";

export const InputPayload = z.object({
  runId: z.string(),
  taskIdentifier: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  environmentType: z.nativeEnum(RuntimeEnvironmentType),
  queue: z.string(),
  concurrencyKey: z.string().optional(),
  timestamp: z.number(),
  attempt: z.number(),
});
export type InputPayload = z.infer<typeof InputPayload>;

export const OutputPayloadV1 = InputPayload.extend({
  version: z.literal("1"),
  masterQueues: z.string().array(),
});
export type OutputPayloadV1 = z.infer<typeof OutputPayloadV1>;

export const OutputPayloadV2 = InputPayload.extend({
  version: z.literal("2"),
  workerQueue: z.string(),
});
export type OutputPayloadV2 = z.infer<typeof OutputPayloadV2>;

export const OutputPayload = z.discriminatedUnion("version", [OutputPayloadV1, OutputPayloadV2]);

export type OutputPayload = z.infer<typeof OutputPayload>;

export type QueueDescriptor = {
  orgId: string;
  projectId: string;
  envId: string;
  queue: string;
  concurrencyKey: string | undefined;
};

export type EnvDescriptor = {
  orgId: string;
  projectId: string;
  envId: string;
};

export interface RunQueueKeyProducer {
  //queue
  queueKey(
    orgId: string,
    projId: string,
    envId: string,
    queue: string,
    concurrencyKey?: string
  ): string;
  queueKey(env: MinimalAuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;

  legacyMasterQueueKey(masterQueueName: string): string;

  masterQueueKeyForEnvironment(envId: string, shardCount: number): string;
  masterQueueKeyForShard(shard: number): string;
  masterQueueShardForEnvironment(envId: string, shardCount: number): number;
  workerQueueKey(workerQueue: string): string;

  envQueueKey(env: MinimalAuthenticatedEnvironment): string;
  envQueueKeyFromQueue(queue: string): string;
  queueConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment, queue: string): string;
  concurrencyLimitKeyFromQueue(queue: string): string;
  currentConcurrencyKeyFromQueue(queue: string): string;
  currentConcurrencyKey(
    env: MinimalAuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string;
  disabledConcurrencyLimitKeyFromQueue(queue: string): string;
  //env oncurrency
  envCurrentConcurrencyKey(env: EnvDescriptor): string;
  envCurrentConcurrencyKey(env: MinimalAuthenticatedEnvironment): string;

  envConcurrencyLimitKey(env: EnvDescriptor): string;
  envConcurrencyLimitKey(env: MinimalAuthenticatedEnvironment): string;

  envConcurrencyLimitKeyFromQueue(queue: string): string;
  envCurrentConcurrencyKeyFromQueue(queue: string): string;
  //message payload
  messageKeyPrefixFromQueue(queue: string): string;
  messageKey(orgId: string, messageId: string): string;
  //utils
  orgIdFromQueue(queue: string): string;
  envIdFromQueue(queue: string): string;
  projectIdFromQueue(queue: string): string;
  descriptorFromQueue(queue: string): QueueDescriptor;

  deadLetterQueueKey(env: MinimalAuthenticatedEnvironment): string;
  deadLetterQueueKey(env: EnvDescriptor): string;
  deadLetterQueueKeyFromQueue(queue: string): string;
}

export type EnvQueues = {
  envId: string;
  queues: string[];
};

export interface RunQueueSelectionStrategy {
  distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<EnvQueues>>;
}
