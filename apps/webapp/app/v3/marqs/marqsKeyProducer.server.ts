import { MarQSKeyProducer, MarQSKeyProducerEnv, QueueDescriptor } from "./types";

const constants = {
  SHARED_QUEUE: "sharedQueue",
  CURRENT_CONCURRENCY_PART: "currentConcurrency",
  CONCURRENCY_LIMIT_PART: "concurrency",
  DISABLED_CONCURRENCY_LIMIT_PART: "disabledConcurrency",
  ENV_PART: "env",
  ORG_PART: "org",
  QUEUE_PART: "queue",
  CONCURRENCY_KEY_PART: "ck",
  MESSAGE_PART: "message",
  RESERVE_CONCURRENCY_PART: "reserveConcurrency",
  PRIORITY_PART: "priority",
} as const;

const ORG_REGEX = /org:(\w+):/;
const ENV_REGEX = /env:(\w+):/;
const QUEUE_REGEX = /queue:([^:]+)(?::|$)/;
const CONCURRENCY_KEY_REGEX = /ck:([^:]+)(?::|$)/;
const PRIORITY_REGEX = /priority:(\d+)(?::|$)/;

export class MarQSShortKeyProducer implements MarQSKeyProducer {
  constructor(private _prefix: string) {}

  sharedQueueScanPattern() {
    return `${this._prefix}*${constants.SHARED_QUEUE}`;
  }

  queueCurrentConcurrencyScanPattern() {
    return `${this._prefix}${constants.ORG_PART}:*:${constants.ENV_PART}:*:queue:*:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  stripKeyPrefix(key: string): string {
    if (key.startsWith(this._prefix)) {
      return key.slice(this._prefix.length);
    }

    return key;
  }

  queueConcurrencyLimitKey(env: MarQSKeyProducerEnv, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(envId: string): string;
  envConcurrencyLimitKey(env: MarQSKeyProducerEnv): string;
  envConcurrencyLimitKey(envOrId: MarQSKeyProducerEnv | string): string {
    return [
      this.envKeySection(typeof envOrId === "string" ? envOrId : envOrId.id),
      constants.CONCURRENCY_LIMIT_PART,
    ].join(":");
  }

  queueKey(
    orgId: string,
    envId: string,
    queue: string,
    concurrencyKey?: string,
    priority?: number
  ): string;
  queueKey(
    env: MarQSKeyProducerEnv,
    queue: string,
    concurrencyKey?: string,
    priority?: number
  ): string;
  queueKey(
    envOrOrgId: MarQSKeyProducerEnv | string,
    queueOrEnvId: string,
    queueOrConcurrencyKey: string,
    concurrencyKeyOrPriority?: string | number,
    priority?: number
  ): string {
    if (typeof envOrOrgId === "string") {
      return [
        this.orgKeySection(envOrOrgId),
        this.envKeySection(queueOrEnvId),
        this.queueSection(queueOrConcurrencyKey),
      ]
        .concat(
          typeof concurrencyKeyOrPriority === "string"
            ? this.concurrencyKeySection(concurrencyKeyOrPriority)
            : []
        )
        .concat(typeof priority === "number" && priority ? this.prioritySection(priority) : [])
        .join(":");
    } else {
      return [
        this.orgKeySection(envOrOrgId.organizationId),
        this.envKeySection(envOrOrgId.id),
        this.queueSection(queueOrEnvId),
      ]
        .concat(queueOrConcurrencyKey ? this.concurrencyKeySection(queueOrConcurrencyKey) : [])
        .concat(
          typeof concurrencyKeyOrPriority === "number" && concurrencyKeyOrPriority
            ? this.prioritySection(concurrencyKeyOrPriority)
            : []
        )
        .join(":");
    }
  }

  envSharedQueueKey(env: MarQSKeyProducerEnv) {
    if (env.type === "DEVELOPMENT") {
      return [
        this.orgKeySection(env.organizationId),
        this.envKeySection(env.id),
        constants.SHARED_QUEUE,
      ].join(":");
    }

    return this.sharedQueueKey();
  }

  sharedQueueKey(): string {
    return constants.SHARED_QUEUE;
  }

  concurrencyLimitKeyFromQueue(queue: string) {
    const concurrencyQueueName = queue.replace(/:ck:.+$/, "");

    return `${concurrencyQueueName}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  // TODO: if the queue passed in has a priority, we need to strip that out
  // before adding the currentConcurrency part
  currentConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  // TODO: if the queue passed in has a priority, we need to strip that out
  // before adding the currentConcurrency part
  queueReserveConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.RESERVE_CONCURRENCY_PART}`;
  }

  currentConcurrencyKey(env: MarQSKeyProducerEnv, queue: string, concurrencyKey?: string): string {
    return [this.queueKey(env, queue, concurrencyKey), constants.CURRENT_CONCURRENCY_PART].join(
      ":"
    );
  }

  envConcurrencyLimitKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.CONCURRENCY_LIMIT_PART}`;
  }

  envCurrentConcurrencyKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  envReserveConcurrencyKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return this.envReserveConcurrencyKey(envId);
  }

  envReserveConcurrencyKey(envId: string): string {
    return `${constants.ENV_PART}:${envId}:${constants.RESERVE_CONCURRENCY_PART}`;
  }

  envCurrentConcurrencyKey(envId: string): string;
  envCurrentConcurrencyKey(env: MarQSKeyProducerEnv): string;
  envCurrentConcurrencyKey(envOrId: MarQSKeyProducerEnv | string): string {
    return [
      this.envKeySection(typeof envOrId === "string" ? envOrId : envOrId.id),
      constants.CURRENT_CONCURRENCY_PART,
    ].join(":");
  }

  envQueueKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.QUEUE_PART}`;
  }

  envQueueKey(env: MarQSKeyProducerEnv): string {
    return [constants.ENV_PART, this.shortId(env.id), constants.QUEUE_PART].join(":");
  }

  messageKey(messageId: string) {
    return `${constants.MESSAGE_PART}:${messageId}`;
  }

  nackCounterKey(messageId: string): string {
    return `${constants.MESSAGE_PART}:${messageId}:nacks`;
  }

  orgIdFromQueue(queue: string) {
    return this.normalizeQueue(queue).split(":")[1];
  }

  envIdFromQueue(queue: string) {
    return this.normalizeQueue(queue).split(":")[3];
  }

  queueDescriptorFromQueue(queue: string): QueueDescriptor {
    const match = queue.match(QUEUE_REGEX);

    if (!match) {
      throw new Error(`Invalid queue: ${queue}`);
    }

    const [, queueName] = match;

    const envMatch = queue.match(ENV_REGEX);

    if (!envMatch) {
      throw new Error(`Invalid queue: ${queue}`);
    }

    const [, envId] = envMatch;

    const orgMatch = queue.match(ORG_REGEX);

    if (!orgMatch) {
      throw new Error(`Invalid queue: ${queue}`);
    }

    const [, orgId] = orgMatch;

    const concurrencyKeyMatch = queue.match(CONCURRENCY_KEY_REGEX);

    const concurrencyKey = concurrencyKeyMatch ? concurrencyKeyMatch[1] : undefined;

    const priorityMatch = queue.match(PRIORITY_REGEX);

    const priority = priorityMatch ? parseInt(priorityMatch[1], 10) : undefined;

    return {
      name: queueName,
      environment: envId,
      organization: orgId,
      concurrencyKey,
      priority,
    };
  }

  private shortId(id: string) {
    // Return the last 12 characters of the id
    return id.slice(-12);
  }

  private envKeySection(envId: string) {
    return `${constants.ENV_PART}:${this.shortId(envId)}`;
  }

  private orgKeySection(orgId: string) {
    return `${constants.ORG_PART}:${this.shortId(orgId)}`;
  }

  private queueSection(queue: string) {
    return `${constants.QUEUE_PART}:${queue}`;
  }

  private concurrencyKeySection(concurrencyKey: string) {
    return `${constants.CONCURRENCY_KEY_PART}:${concurrencyKey}`;
  }

  private prioritySection(priority: number) {
    return `${constants.PRIORITY_PART}:${priority}`;
  }

  // This removes the leading prefix from the queue name if it exists
  private normalizeQueue(queue: string) {
    if (queue.startsWith(this._prefix)) {
      return queue.slice(this._prefix.length);
    }

    return queue;
  }
}
