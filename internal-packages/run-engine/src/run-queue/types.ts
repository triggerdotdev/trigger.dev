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
  rateLimitKey: z.string().optional(),
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

export type RunQueueKeyProducerEnvironment = Omit<
  MinimalAuthenticatedEnvironment,
  "maximumConcurrencyLimit" | "concurrencyLimitBurstFactor"
>;

export interface RunQueueKeyProducer {
  //queue
  queueKey(
    orgId: string,
    projId: string,
    envId: string,
    queue: string,
    concurrencyKey?: string
  ): string;
  queueKey(env: RunQueueKeyProducerEnvironment, queue: string, concurrencyKey?: string): string;

  legacyMasterQueueKey(masterQueueName: string): string;

  masterQueueKeyForEnvironment(envId: string, shardCount: number): string;
  masterQueueKeyForShard(shard: number): string;
  masterQueueShardForEnvironment(envId: string, shardCount: number): number;
  workerQueueKey(workerQueue: string): string;

  envQueueKey(env: RunQueueKeyProducerEnvironment): string;
  envQueueKeyFromQueue(queue: string): string;
  queueConcurrencyLimitKey(env: RunQueueKeyProducerEnvironment, queue: string): string;
  queueConcurrencyLimitKeyFromQueue(queue: string): string;
  queueCurrentConcurrencyKeyFromQueue(queue: string): string;
  queueCurrentConcurrencyKey(
    env: RunQueueKeyProducerEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string;
  queueCurrentDequeuedKeyFromQueue(queue: string): string;
  queueCurrentDequeuedKey(
    env: RunQueueKeyProducerEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string;

  //env oncurrency
  envCurrentConcurrencyKey(env: EnvDescriptor): string;
  envCurrentConcurrencyKey(env: RunQueueKeyProducerEnvironment): string;

  envConcurrencyLimitKey(env: EnvDescriptor): string;
  envConcurrencyLimitKey(env: RunQueueKeyProducerEnvironment): string;

  envCurrentDequeuedKey(env: EnvDescriptor): string;
  envCurrentDequeuedKey(env: RunQueueKeyProducerEnvironment): string;

  envConcurrencyLimitBurstFactorKey(env: EnvDescriptor): string;
  envConcurrencyLimitBurstFactorKey(env: RunQueueKeyProducerEnvironment): string;
  envConcurrencyLimitBurstFactorKeyFromQueue(queue: string): string;

  envConcurrencyLimitKeyFromQueue(queue: string): string;
  envCurrentConcurrencyKeyFromQueue(queue: string): string;
  envCurrentDequeuedKeyFromQueue(queue: string): string;

  //message payload
  messageKeyPrefixFromQueue(queue: string): string;
  messageKey(orgId: string, messageId: string): string;
  //utils
  orgIdFromQueue(queue: string): string;
  envIdFromQueue(queue: string): string;
  projectIdFromQueue(queue: string): string;
  descriptorFromQueue(queue: string): QueueDescriptor;

  deadLetterQueueKey(env: RunQueueKeyProducerEnvironment): string;
  deadLetterQueueKey(env: EnvDescriptor): string;
  deadLetterQueueKeyFromQueue(queue: string): string;

  // Concurrency sweeper methods
  markedForAckKey(): string;
  currentConcurrencySetKeyScanPattern(): string;

  // Rate limiting keys
  queueRateLimitConfigKey(env: RunQueueKeyProducerEnvironment, queue: string): string;
  queueRateLimitBucketKey(
    env: RunQueueKeyProducerEnvironment,
    queue: string,
    rateLimitKey?: string
  ): string;
  queueRateLimitConfigKeyFromQueue(queue: string): string;
  queueRateLimitBucketKeyFromQueue(queue: string, rateLimitKey?: string): string;
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
