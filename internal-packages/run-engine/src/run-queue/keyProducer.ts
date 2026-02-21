import type { RunQueueKeyProducerEnvironment } from "./types.js";
import { EnvDescriptor, QueueDescriptor, RunQueueKeyProducer } from "./types.js";
import { jumpHash } from "@trigger.dev/core/v3/serverOnly";

const constants = {
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CURRENT_DEQUEUED_PART: "currentDequeued",
  CONCURRENCY_LIMIT_PART: "concurrency",
  CONCURRENCY_LIMIT_BURST_FACTOR_PART: "concurrencyBurstFactor",
  ENV_PART: "env",
  ORG_PART: "org",
  PROJECT_PART: "proj",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  TASK_PART: "task",
  MESSAGE_PART: "message",
  DEAD_LETTER_QUEUE_PART: "deadLetter",
  MASTER_QUEUE_PART: "masterQueue",
  WORKER_QUEUE_PART: "workerQueue",
  RATE_LIMIT_PART: "rl",
  RATE_LIMIT_CONFIG_PART: "rl:config",
} as const;

export class RunQueueFullKeyProducer implements RunQueueKeyProducer {
  legacyMasterQueueKey(masterQueueName: string): string {
    return masterQueueName;
  }

  masterQueueKeyForEnvironment(envId: string, shardCount: number): string {
    const shard = this.masterQueueShardForEnvironment(envId, shardCount);

    return this.masterQueueKeyForShard(shard);
  }

  masterQueueKeyForShard(shard: number): string {
    return [constants.MASTER_QUEUE_PART, "shard", shard.toString()].join(":");
  }

  masterQueueShardForEnvironment(envId: string, shardCount: number): number {
    return jumpHash(envId, shardCount);
  }

  workerQueueKey(workerQueue: string): string {
    return [constants.WORKER_QUEUE_PART, workerQueue].join(":");
  }

  queueConcurrencyLimitKey(env: RunQueueKeyProducerEnvironment, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(env: EnvDescriptor): string;
  envConcurrencyLimitKey(env: RunQueueKeyProducerEnvironment): string;
  envConcurrencyLimitKey(envOrDescriptor: EnvDescriptor | RunQueueKeyProducerEnvironment): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.CONCURRENCY_LIMIT_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.CONCURRENCY_LIMIT_PART,
      ].join(":");
    }
  }

  envConcurrencyLimitBurstFactorKey(env: EnvDescriptor): string;
  envConcurrencyLimitBurstFactorKey(env: RunQueueKeyProducerEnvironment): string;
  envConcurrencyLimitBurstFactorKey(
    envOrDescriptor: EnvDescriptor | RunQueueKeyProducerEnvironment
  ): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.CONCURRENCY_LIMIT_BURST_FACTOR_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.CONCURRENCY_LIMIT_BURST_FACTOR_PART,
      ].join(":");
    }
  }

  queueKey(
    orgId: string,
    projId: string,
    envId: string,
    queue: string,
    concurrencyKey?: string
  ): string;
  queueKey(env: RunQueueKeyProducerEnvironment, queue: string, concurrencyKey?: string): string;
  queueKey(
    envOrOrgId: RunQueueKeyProducerEnvironment | string,
    projIdOrQueue: string,
    envIdConcurrencyKey?: string,
    queue?: string,
    concurrencyKey?: string
  ): string {
    if (typeof envOrOrgId !== "string") {
      return [
        this.orgKeySection(envOrOrgId.organization.id),
        this.projKeySection(envOrOrgId.project.id),
        this.envKeySection(envOrOrgId.id),
        this.queueSection(projIdOrQueue),
      ]
        .concat(envIdConcurrencyKey ? this.concurrencyKeySection(envIdConcurrencyKey) : [])
        .join(":");
    }

    return [
      this.orgKeySection(envOrOrgId),
      this.projKeySection(projIdOrQueue),
      this.envKeySection(envIdConcurrencyKey!),
      this.queueSection(queue!),
    ]
      .concat(concurrencyKey ? this.concurrencyKeySection(concurrencyKey) : [])
      .join(":");
  }

  envQueueKey(env: RunQueueKeyProducerEnvironment) {
    return [this.orgKeySection(env.organization.id), this.envKeySection(env.id)].join(":");
  }

  envQueueKeyFromQueue(queue: string) {
    const { orgId, envId } = this.descriptorFromQueue(queue);
    return [this.orgKeySection(orgId), this.envKeySection(envId)].join(":");
  }

  queueConcurrencyLimitKeyFromQueue(queue: string) {
    const concurrencyQueueName = queue.replace(/:ck:.+$/, "");
    return `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  queueCurrentConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  queueCurrentDequeuedKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_DEQUEUED_PART}`;
  }

  queueCurrentDequeuedKey(
    env: RunQueueKeyProducerEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_DEQUEUED_PART].join(":");
  }

  queueCurrentConcurrencyKey(
    env: RunQueueKeyProducerEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_CONCURRENCY_PART].join(
      ":"
    );
  }

  envConcurrencyLimitKeyFromQueue(queue: string) {
    const { orgId, projectId, envId } = this.descriptorFromQueue(queue);

    return this.envConcurrencyLimitKey({
      orgId,
      projectId,
      envId,
    });
  }

  envConcurrencyLimitBurstFactorKeyFromQueue(queue: string) {
    const { orgId, projectId, envId } = this.descriptorFromQueue(queue);

    return this.envConcurrencyLimitBurstFactorKey({
      orgId,
      projectId,
      envId,
    });
  }

  envCurrentConcurrencyKeyFromQueue(queue: string) {
    const { orgId, envId, projectId } = this.descriptorFromQueue(queue);

    return this.envCurrentConcurrencyKey({
      orgId,
      projectId,
      envId,
    });
  }

  envCurrentConcurrencyKey(env: EnvDescriptor): string;
  envCurrentConcurrencyKey(env: RunQueueKeyProducerEnvironment): string;
  envCurrentConcurrencyKey(
    envOrDescriptor: EnvDescriptor | RunQueueKeyProducerEnvironment
  ): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.CURRENT_CONCURRENCY_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.CURRENT_CONCURRENCY_PART,
      ].join(":");
    }
  }

  envCurrentDequeuedKeyFromQueue(queue: string) {
    const { orgId, envId, projectId } = this.descriptorFromQueue(queue);

    return this.envCurrentDequeuedKey({
      orgId,
      projectId,
      envId,
    });
  }

  envCurrentDequeuedKey(env: EnvDescriptor): string;
  envCurrentDequeuedKey(env: RunQueueKeyProducerEnvironment): string;
  envCurrentDequeuedKey(envOrDescriptor: EnvDescriptor | RunQueueKeyProducerEnvironment): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.CURRENT_DEQUEUED_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.CURRENT_DEQUEUED_PART,
      ].join(":");
    }
  }

  messageKeyPrefixFromQueue(queue: string) {
    const { orgId } = this.descriptorFromQueue(queue);
    return `${this.orgKeySection(orgId)}:${constants.MESSAGE_PART}:`;
  }

  messageKey(orgId: string, messageId: string) {
    return [this.orgKeySection(orgId), `${constants.MESSAGE_PART}:${messageId}`]
      .filter(Boolean)
      .join(":");
  }

  orgIdFromQueue(queue: string): string {
    return this.descriptorFromQueue(queue).orgId;
  }

  envIdFromQueue(queue: string): string {
    return this.descriptorFromQueue(queue).envId;
  }

  projectIdFromQueue(queue: string): string {
    return this.descriptorFromQueue(queue).projectId;
  }

  deadLetterQueueKey(env: RunQueueKeyProducerEnvironment): string;
  deadLetterQueueKey(env: EnvDescriptor): string;
  deadLetterQueueKey(envOrDescriptor: EnvDescriptor | RunQueueKeyProducerEnvironment): string {
    if ("id" in envOrDescriptor) {
      return [
        this.orgKeySection(envOrDescriptor.organization.id),
        this.projKeySection(envOrDescriptor.project.id),
        this.envKeySection(envOrDescriptor.id),
        constants.DEAD_LETTER_QUEUE_PART,
      ].join(":");
    } else {
      return [
        this.orgKeySection(envOrDescriptor.orgId),
        this.projKeySection(envOrDescriptor.projectId),
        this.envKeySection(envOrDescriptor.envId),
        constants.DEAD_LETTER_QUEUE_PART,
      ].join(":");
    }
  }
  deadLetterQueueKeyFromQueue(queue: string): string {
    const { orgId, projectId, envId } = this.descriptorFromQueue(queue);
    return this.deadLetterQueueKey({ orgId, projectId, envId });
  }

  markedForAckKey(): string {
    return "markedForAck";
  }

  currentConcurrencySetKeyScanPattern(): string {
    return `*:${constants.ENV_PART}:*:queue:*:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  /**
   * Key for storing rate limit configuration for a queue.
   * Pattern: {org:X}:proj:Y:env:Z:queue:Q:rl:config
   */
  queueRateLimitConfigKey(env: RunQueueKeyProducerEnvironment, queue: string): string {
    return [this.queueKeyBase(env, queue), constants.RATE_LIMIT_CONFIG_PART].join(":");
  }

  /**
   * Key for the GCRA rate limit bucket for a queue.
   * If rateLimitKey is provided, creates a separate bucket per key (per-tenant).
   * Pattern: {org:X}:proj:Y:env:Z:queue:Q:rl[:key]
   */
  queueRateLimitBucketKey(
    env: RunQueueKeyProducerEnvironment,
    queue: string,
    rateLimitKey?: string
  ): string {
    const base = [this.queueKeyBase(env, queue), constants.RATE_LIMIT_PART].join(":");
    return rateLimitKey ? `${base}:${rateLimitKey}` : base;
  }

  /**
   * Get rate limit config key from a queue key.
   * Strips concurrency key suffix if present.
   */
  queueRateLimitConfigKeyFromQueue(queue: string): string {
    // Remove concurrency key suffix to get base queue
    const baseQueue = queue.replace(/:ck:.+$/, "");
    return `${baseQueue}:${constants.RATE_LIMIT_CONFIG_PART}`;
  }

  /**
   * Get rate limit bucket key from a queue key.
   */
  queueRateLimitBucketKeyFromQueue(queue: string, rateLimitKey?: string): string {
    // Remove concurrency key suffix to get base queue
    const baseQueue = queue.replace(/:ck:.+$/, "");
    const base = `${baseQueue}:${constants.RATE_LIMIT_PART}`;
    return rateLimitKey ? `${base}:${rateLimitKey}` : base;
  }

  /**
   * Helper to get the base queue key (without concurrency key).
   */
  private queueKeyBase(env: RunQueueKeyProducerEnvironment, queue: string): string {
    return [
      this.orgKeySection(env.organization.id),
      this.projKeySection(env.project.id),
      this.envKeySection(env.id),
      this.queueSection(queue),
    ].join(":");
  }

  descriptorFromQueue(queue: string): QueueDescriptor {
    const parts = queue.split(":");
    return {
      orgId: parts[1].replace("{", "").replace("}", ""),
      projectId: parts[3],
      envId: parts[5],
      queue: parts[7],
      concurrencyKey: parts.at(9),
    };
  }

  private envKeySection(envId: string) {
    return `${constants.ENV_PART}:${envId}`;
  }

  private projKeySection(projId: string) {
    return `${constants.PROJECT_PART}:${projId}`;
  }

  private orgKeySection(orgId: string) {
    return `{${constants.ORG_PART}:${orgId}}`;
  }

  private queueSection(queue: string) {
    return `${constants.QUEUE_PART}:${queue}`;
  }

  private concurrencyKeySection(concurrencyKey: string) {
    return `${constants.CONCURRENCY_KEY_PART}:${concurrencyKey}`;
  }

  private taskIdentifierSection(taskIdentifier: string) {
    return `${constants.TASK_PART}:${taskIdentifier}`;
  }
}
