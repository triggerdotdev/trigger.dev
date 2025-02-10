import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { MarQSKeyProducer } from "./types";

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
} as const;

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

  queueConcurrencyLimitKey(env: AuthenticatedEnvironment, queue: string) {
    return [this.queueKey(env, queue), constants.CONCURRENCY_LIMIT_PART].join(":");
  }

  envConcurrencyLimitKey(envId: string): string;
  envConcurrencyLimitKey(env: AuthenticatedEnvironment): string;
  envConcurrencyLimitKey(envOrId: AuthenticatedEnvironment | string): string {
    return [
      this.envKeySection(typeof envOrId === "string" ? envOrId : envOrId.id),
      constants.CONCURRENCY_LIMIT_PART,
    ].join(":");
  }

  queueKey(orgId: string, envId: string, queue: string, concurrencyKey?: string): string;
  queueKey(env: AuthenticatedEnvironment, queue: string, concurrencyKey?: string): string;
  queueKey(
    envOrOrgId: AuthenticatedEnvironment | string,
    queueOrEnvId: string,
    queueOrConcurrencyKey: string,
    concurrencyKey?: string
  ): string {
    if (typeof envOrOrgId === "string") {
      return [
        this.orgKeySection(envOrOrgId),
        this.envKeySection(queueOrEnvId),
        this.queueSection(queueOrConcurrencyKey),
      ]
        .concat(concurrencyKey ? this.concurrencyKeySection(concurrencyKey) : [])
        .join(":");
    } else {
      return [
        this.orgKeySection(envOrOrgId.organizationId),
        this.envKeySection(envOrOrgId.id),
        this.queueSection(queueOrEnvId),
      ]
        .concat(queueOrConcurrencyKey ? this.concurrencyKeySection(queueOrConcurrencyKey) : [])
        .join(":");
    }
  }

  envSharedQueueKey(env: AuthenticatedEnvironment) {
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

  currentConcurrencyKeyFromQueue(queue: string) {
    return `${queue}:${constants.CURRENT_CONCURRENCY_PART}`;
  }

  currentConcurrencyKey(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrencyKey?: string
  ): string {
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
  envCurrentConcurrencyKey(env: AuthenticatedEnvironment): string;
  envCurrentConcurrencyKey(envOrId: AuthenticatedEnvironment | string): string {
    return [
      this.envKeySection(typeof envOrId === "string" ? envOrId : envOrId.id),
      constants.CURRENT_CONCURRENCY_PART,
    ].join(":");
  }

  envQueueKeyFromQueue(queue: string) {
    const envId = this.normalizeQueue(queue).split(":")[3];

    return `${constants.ENV_PART}:${envId}:${constants.QUEUE_PART}`;
  }

  envQueueKey(env: AuthenticatedEnvironment): string {
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

  // This removes the leading prefix from the queue name if it exists
  private normalizeQueue(queue: string) {
    if (queue.startsWith(this._prefix)) {
      return queue.slice(this._prefix.length);
    }

    return queue;
  }
}
