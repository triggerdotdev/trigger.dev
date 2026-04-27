import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type { FairQueueKeyProducer } from "./types.js";

export interface WorkerQueueManagerOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * WorkerQueueManager handles the intermediate worker queue layer.
 *
 * This provides:
 * - Low-latency message delivery via blocking pop (BLPOP)
 * - Routing of messages to specific workers/consumers
 * - Efficient waiting without polling
 *
 * Flow:
 * 1. Master queue consumer claims message from message queue
 * 2. Message key is pushed to worker queue
 * 3. Worker queue consumer does blocking pop to receive message
 */
export class WorkerQueueManager {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private logger: NonNullable<WorkerQueueManagerOptions["logger"]>;

  constructor(private options: WorkerQueueManagerOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.logger = options.logger ?? {
      debug: () => {},
      error: () => {},
    };
    this.#registerCommands();
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Push a message key to a worker queue.
   * Called after claiming a message from the message queue.
   *
   * @param workerQueueId - The worker queue identifier
   * @param messageKey - The message key to push (typically "messageId:queueId")
   */
  async push(workerQueueId: string, messageKey: string): Promise<void> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);
    await this.redis.rpush(workerQueueKey, messageKey);

    this.logger.debug("Pushed to worker queue", {
      workerQueueId,
      workerQueueKey,
      messageKey,
    });
  }

  /**
   * Push multiple message keys to a worker queue.
   *
   * @param workerQueueId - The worker queue identifier
   * @param messageKeys - The message keys to push
   */
  async pushBatch(workerQueueId: string, messageKeys: string[]): Promise<void> {
    if (messageKeys.length === 0) {
      return;
    }

    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);
    await this.redis.rpush(workerQueueKey, ...messageKeys);

    this.logger.debug("Pushed batch to worker queue", {
      workerQueueId,
      workerQueueKey,
      count: messageKeys.length,
    });
  }

  /**
   * Blocking pop from a worker queue.
   * Waits until a message is available or timeout expires.
   *
   * @param workerQueueId - The worker queue identifier
   * @param timeoutSeconds - Maximum time to wait (0 = wait forever)
   * @param signal - Optional abort signal to cancel waiting
   * @returns The message key, or null if timeout
   */
  async blockingPop(
    workerQueueId: string,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);

    // Create a separate client for blocking operation
    // This is required because BLPOP blocks the connection
    const blockingClient = this.redis.duplicate();

    // Define cleanup outside try so it's accessible in finally
    // This prevents listener accumulation on the AbortSignal
    const cleanup = signal
      ? () => {
          blockingClient.disconnect();
        }
      : null;

    try {
      // Set up abort handler
      if (signal && cleanup) {
        signal.addEventListener("abort", cleanup, { once: true });

        if (signal.aborted) {
          return null;
        }
      }

      const result = await blockingClient.blpop(workerQueueKey, timeoutSeconds);

      if (!result) {
        return null;
      }

      // BLPOP returns [key, value]
      const [, messageKey] = result;

      this.logger.debug("Blocking pop received message", {
        workerQueueId,
        workerQueueKey,
        messageKey,
      });

      return messageKey;
    } catch (error) {
      // Handle abort/disconnect
      if (signal?.aborted) {
        return null;
      }

      this.logger.error("Blocking pop error", {
        workerQueueId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      // Always remove the listener to prevent accumulation on the AbortSignal
      // (once: true only removes if abort fires, not on normal completion)
      if (cleanup && signal) {
        signal.removeEventListener("abort", cleanup);
      }
      await blockingClient.quit().catch(() => {
        // Ignore quit errors (may already be disconnected)
      });
    }
  }

  /**
   * Non-blocking pop from a worker queue.
   *
   * @param workerQueueId - The worker queue identifier
   * @returns The message key and queue length, or null if empty
   */
  async pop(workerQueueId: string): Promise<{ messageKey: string; queueLength: number } | null> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);

    const result = await this.redis.popWithLength(workerQueueKey);

    if (!result) {
      return null;
    }

    const [messageKey, queueLength] = result;

    this.logger.debug("Non-blocking pop received message", {
      workerQueueId,
      workerQueueKey,
      messageKey,
      queueLength,
    });

    return { messageKey, queueLength: Number(queueLength) };
  }

  /**
   * Get the current length of a worker queue.
   */
  async getLength(workerQueueId: string): Promise<number> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);
    return await this.redis.llen(workerQueueKey);
  }

  /**
   * Peek at all messages in a worker queue without removing them.
   * Useful for debugging and tests.
   */
  async peek(workerQueueId: string): Promise<string[]> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);
    return await this.redis.lrange(workerQueueKey, 0, -1);
  }

  /**
   * Remove a specific message from the worker queue.
   * Used when a message needs to be removed without processing.
   *
   * @param workerQueueId - The worker queue identifier
   * @param messageKey - The message key to remove
   * @returns Number of removed items
   */
  async remove(workerQueueId: string, messageKey: string): Promise<number> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);
    return await this.redis.lrem(workerQueueKey, 0, messageKey);
  }

  /**
   * Clear all messages from a worker queue.
   */
  async clear(workerQueueId: string): Promise<void> {
    const workerQueueKey = this.keys.workerQueueKey(workerQueueId);
    await this.redis.del(workerQueueKey);
  }

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  // ============================================================================
  // Private - Register Commands
  // ============================================================================

  /**
   * Initialize custom Redis commands.
   */
  #registerCommands(): void {
    // Non-blocking pop with queue length
    this.redis.defineCommand("popWithLength", {
      numberOfKeys: 1,
      lua: `
local workerQueueKey = KEYS[1]

-- Pop the first message
local messageKey = redis.call('LPOP', workerQueueKey)
if not messageKey then
  return nil
end

-- Get remaining queue length
local queueLength = redis.call('LLEN', workerQueueKey)

return {messageKey, queueLength}
      `,
    });
  }

  /**
   * Register custom commands on an external Redis client.
   * Use this when initializing FairQueue with worker queues.
   */
  registerCommands(redis: Redis): void {
    redis.defineCommand("popWithLength", {
      numberOfKeys: 1,
      lua: `
local workerQueueKey = KEYS[1]

-- Pop the first message
local messageKey = redis.call('LPOP', workerQueueKey)
if not messageKey then
  return nil
end

-- Get remaining queue length
local queueLength = redis.call('LLEN', workerQueueKey)

return {messageKey, queueLength}
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    popWithLength(workerQueueKey: string): Promise<[string, string] | null>;
  }
}
