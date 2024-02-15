import Redis, { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { z } from "zod";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { singleton } from "~/utils/singleton";

const KEY_PREFIX = "marqs:";

type MarQSOptions = {
  redis: RedisOptions;
  defaultConcurrency?: number;
  windowSize?: number;
  visibilityTimeout?: number;
  workers: number;
};

const SHARED_QUEUE = "sharedQueue";
const TIMEOUT_QUEUE = "timeoutQueue";

const MessagePayload = z.object({
  version: z.literal("1"),
  data: z.record(z.unknown()),
  queue: z.string(),
  messageId: z.string(),
  timestamp: z.number(),
  parentQueue: z.string(),
  concurrencyKey: z.string().optional(),
});

type MessagePayload = z.infer<typeof MessagePayload>;

class AsyncWorker {
  private running = false;
  private timeout?: NodeJS.Timeout;

  constructor(private readonly fn: () => Promise<void>, private readonly interval: number) {}

  start() {
    if (this.running) {
      return;
    }

    this.running = true;

    this.#run();
  }

  stop() {
    this.running = false;
  }

  async #run() {
    if (!this.running) {
      return;
    }

    try {
      await this.fn();
    } catch (e) {
      console.error(e);
    }

    this.timeout = setTimeout(this.#run.bind(this), this.interval);
  }
}

/**
 * MarQS - Modular Asynchronous Reliable Queueing System (pronounced "markus")
 */
export class MarQS {
  private redis: Redis;
  #requeueingWorkers: Array<AsyncWorker> = [];

  constructor(private readonly options: MarQSOptions) {
    this.redis = new Redis(options.redis);

    // Spawn options.workers workers to requeue visible messages
    this.#startRequeuingWorkers();
  }

  public async updateQueueConcurrency(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrency: number
  ) {
    return this.redis.hset(`env:${env.id}:queue:${queue}:metadata`, "concurrency", concurrency);
  }

  // Dev queues shouldn't touch the main parent queue
  // Dev queues still need to work with concurrency keys? (maybe dev queue parent queue is `env:${env.id}:mainQueue`)
  // Production queues will touch the main parent queue
  public async enqueueMessage(
    env: AuthenticatedEnvironment,
    queue: string,
    messageId: string,
    messageData: Record<string, unknown>,
    concurrencyKey?: string
  ) {
    const fullyQualifiedQueue = `env:${env.id}:queue:${queue}${
      concurrencyKey ? `:ck:${concurrencyKey}` : ""
    }`;

    const timestamp = Date.now();

    const parentQueue = env.type === "DEVELOPMENT" ? `env:${env.id}:${SHARED_QUEUE}` : SHARED_QUEUE;

    const messagePayload: MessagePayload = {
      version: "1",
      data: messageData,
      queue: fullyQualifiedQueue,
      concurrencyKey,
      timestamp,
      messageId,
      parentQueue,
    };

    await this.#writeMessage(messagePayload);
    await this.#enqueueMessage(messagePayload);
  }

  public async dequeueMessageInEnv(env: AuthenticatedEnvironment) {
    const parentQueue = env.type === "DEVELOPMENT" ? `env:${env.id}:${SHARED_QUEUE}` : SHARED_QUEUE;

    // Read the parent queue for matching queues
    const queues = await this.redis.zrange(parentQueue, 0, -1);

    if (queues.length === 0) {
      return;
    }

    // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
    const shuffledQueues = await this.#priorityShuffle(queues);
    const highestPriorityQueue = shuffledQueues[0];

    // Pop the earliest messages from the highest priority queue
    const messages = await this.redis.zrange(highestPriorityQueue, 0, 0, "WITHSCORES");

    const messageId = messages[0];
    const message = await this.#readMessage(messageId);

    if (!message) {
      await this.redis.zrem(highestPriorityQueue, messageId); // Remove the message from the queue

      return;
    }

    const score = parseInt(messages[1]);
    const timeoutScore = score + (this.options.visibilityTimeout ?? 300000); // 5 minutes

    const timeoutChildQueue = `${highestPriorityQueue}:timeout`;

    await this.redis
      .multi()
      .zrem(highestPriorityQueue, messageId)
      .zadd(timeoutChildQueue, timeoutScore, messageId)
      .exec();

    await this.#rebalanceParentQueueForChildQueue({
      parentQueue: TIMEOUT_QUEUE,
      childQueue: timeoutChildQueue,
    });
    await this.#rebalanceParentQueueForChildQueue({
      parentQueue,
      childQueue: highestPriorityQueue,
    });

    return message;
  }

  public async acknowledgeMessage(messageId: string) {
    const message = await this.#readMessage(messageId);

    if (!message) {
      return;
    }

    const timeoutQueue = `${message.queue}:timeout`;

    await this.redis.multi().del(`message:${messageId}`).zrem(timeoutQueue, messageId).exec();
    await this.#rebalanceParentQueueForChildQueue({
      parentQueue: TIMEOUT_QUEUE,
      childQueue: timeoutQueue,
    });
  }

  /**
   * Negative acknowledge a message, which will requeue the message
   */
  public async nackMessage(messageId: string) {
    const message = await this.#readMessage(messageId);

    if (!message) {
      return;
    }

    const fullyQualifiedQueue = message.queue;

    // Need to remove the message from the timeout queue and "rebalance" the TIMEOUT parent queue
    const timeoutQueue = `${fullyQualifiedQueue}:timeout`;

    await this.redis.zrem(timeoutQueue, messageId);
    await this.#rebalanceParentQueueForChildQueue({
      parentQueue: TIMEOUT_QUEUE,
      childQueue: timeoutQueue,
    });

    // Requeue the message
    await this.#enqueueMessage(message);
  }

  async #enqueueMessage(message: MessagePayload) {
    const fullyQualifiedQueue = message.queue;

    await this.redis.zadd(fullyQualifiedQueue, message.timestamp, message.messageId);

    await this.#rebalanceParentQueueForChildQueue({
      parentQueue: message.parentQueue,
      childQueue: fullyQualifiedQueue,
    });
  }

  async #writeMessage(message: MessagePayload) {
    return this.redis.set(
      `message:${message.messageId}`,
      JSON.stringify({
        version: "1",
        data: message.data,
        queue: message.queue,
        concurrencyKey: message.concurrencyKey,
        timestamp: message.timestamp,
        messageId: message.messageId,
        parentQueue: message.parentQueue,
      })
    );
  }

  async #readMessage(messageId: string) {
    const rawMessage = await this.redis.get(`message:${messageId}`);

    if (!rawMessage) {
      return;
    }

    const message = MessagePayload.safeParse(JSON.parse(rawMessage));

    if (!message.success) {
      return;
    }

    return message.data;
  }

  // TODO - flesh this out more
  async #priorityShuffle(queues: string[]) {
    const shuffledQueues = [...queues];

    for (let i = shuffledQueues.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledQueues[i], shuffledQueues[j]] = [shuffledQueues[j], shuffledQueues[i]];
    }

    return shuffledQueues;
  }

  async #rebalanceParentQueueForChildQueue({
    parentQueue,
    childQueue,
  }: {
    parentQueue: string;
    childQueue: string;
  }) {
    // Get the earliest task from the child queue
    const earliestTask = await this.redis.zrange(childQueue, 0, 0, "WITHSCORES");

    if (earliestTask.length === 0) {
      // Remove the child queue from the parent queue

      return this.redis.zrem(parentQueue, childQueue);
    }

    // Update the score of the child queue in the parent queue
    return this.redis.zadd(parentQueue, earliestTask[1], childQueue);
  }

  #startRequeuingWorkers() {
    // Start a new worker to requeue visible messages
    for (let i = 0; i < this.options.workers; i++) {
      const worker = new AsyncWorker(this.#requeueVisibleMessages.bind(this), 1000);

      this.#requeueingWorkers.push(worker);

      worker.start();
    }
  }

  async #requeueVisibleMessages() {
    const timeoutQueues = await this.redis.zrange(TIMEOUT_QUEUE, 0, -1);

    if (timeoutQueues.length === 0) {
      return;
    }

    // We need to do the priority shuffling here to ensure all workers aren't just working on the highest priority queue
    const shuffledQueues = await this.#priorityShuffle(timeoutQueues);
    const highestPriorityTimeoutQueue = shuffledQueues[0];

    // Remove any of the messages from the highestPriorityTimeoutQueue that have expired
    const messages = await this.redis.zrangebyscore(highestPriorityTimeoutQueue, 0, Date.now());

    if (messages.length === 0) {
      return;
    }

    const childQueue = highestPriorityTimeoutQueue.replace(":timeout", "");

    await this.redis.zrem(highestPriorityTimeoutQueue, ...messages);
    await this.redis.zadd(childQueue, Date.now(), ...messages);

    const messagePayloads = await Promise.all(
      messages.map((messageId) => this.#readMessage(messageId))
    ).then((messages) => messages.filter(Boolean));

    const rebalances: Map<string, { parentQueue: string; childQueue: string }> = new Map();

    for (const messagePayload of messagePayloads) {
      if (!messagePayload) {
        continue;
      }

      rebalances.set(`${messagePayload.parentQueue}:${messagePayload.queue}`, {
        parentQueue: messagePayload.parentQueue,
        childQueue,
      });
    }

    await Promise.all(
      Array.from(rebalances.values()).map(({ parentQueue, childQueue }) =>
        this.#rebalanceParentQueueForChildQueue({ parentQueue, childQueue })
      )
    );

    await this.#rebalanceParentQueueForChildQueue({
      parentQueue: TIMEOUT_QUEUE,
      childQueue: highestPriorityTimeoutQueue,
    });
  }
}

export const marqs = singleton("marqs", getMarQSClient);

function getMarQSClient() {
  if (env.REDIS_HOST && env.REDIS_PORT) {
    return new MarQS({
      workers: 1,
      redis: {
        keyPrefix: KEY_PREFIX,
        port: env.REDIS_PORT,
        host: env.REDIS_HOST,
        username: env.REDIS_USERNAME,
        password: env.REDIS_PASSWORD,
        enableAutoPipelining: true,
        ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
      defaultConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
    });
  }
}
