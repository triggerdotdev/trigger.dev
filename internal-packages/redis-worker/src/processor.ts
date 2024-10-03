import { z } from "zod";
import { SimpleQueue } from "./queue.js";
import { Logger } from "@trigger.dev/core/logger";

type QueueProcessorOptions<T extends z.ZodType> = {
  timeout?: number;
  retry?: {
    delay?: {
      initial?: number;
      max?: number;
      factor?: number;
    };
    maxAttempts?: number;
  };
  logger?: Logger;
  onItem: (id: string, item: z.infer<T>) => Promise<void> | void;
};

const defaultRetryOptions = {
  delay: {
    initial: 1000,
    max: 10000,
    factor: 2,
  },
  maxAttempts: 10,
};

export function createQueueProcessor<T extends z.ZodType>(
  queue: SimpleQueue<T>,
  options: QueueProcessorOptions<T>
) {
  let { timeout = 1000, onItem, logger = new Logger("QueueProcessor", "debug") } = options;

  const retry = deepMerge(defaultRetryOptions, options.retry ?? {});

  const failures = new Map<string, number>();
  let isRunning = false;

  async function processQueue() {
    if (!isRunning) return;

    try {
      const result = await queue.dequeue();
      if (result) {
        const { id, item } = result;
        try {
          await onItem(id, item);
        } catch (error) {
          logger.warn("Error processing item:", { error, id, item, queue: queue.name });

          const retryCount = failures.get(id) || 0;
          if (retryCount >= retry.maxAttempts) {
            logger.error(`QueueProcessor: max attempts reached for item ${id}`, {
              queue: queue.name,
              id,
              item,
            });
            return;
          }

          //requeue with delay
          const delay = Math.min(
            retry.delay.initial * Math.pow(retry.delay.factor, retryCount),
            retry.delay.max
          );
          logger.log(`QueueProcessor: requeueing item`, { item, id, delay, queue: queue.name });
          await queue.enqueue(id, item, new Date(Date.now() + delay));

          failures.set(id, retryCount + 1);
        }
        // Continue processing immediately if still running
        if (isRunning) {
          setImmediate(processQueue);
        }
      } else {
        // No item found, wait before checking again if still running
        if (isRunning) {
          setTimeout(processQueue, timeout);
        }
      }
    } catch (error) {
      logger.error("Error processing queue:", { error });
      setTimeout(processQueue, timeout);
    }
  }

  return {
    start: () => {
      if (!isRunning) {
        logger.log("Starting queue processor...");
        isRunning = true;
        processQueue();
      } else {
        logger.log("Queue processor is already running.");
      }
    },
    stop: () => {
      if (isRunning) {
        logger.log("Stopping queue processor...");
        isRunning = false;
      } else {
        logger.log("Queue processor is already stopped.");
      }
    },
  };
}

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

function isObject(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  if (!isObject(target) || !isObject(source)) {
    return source as T;
  }

  const output = { ...target } as T;

  (Object.keys(source) as Array<keyof T>).forEach((key) => {
    if (key in target) {
      const targetValue = target[key];
      const sourceValue = source[key];

      if (isObject(targetValue) && isObject(sourceValue)) {
        (output as any)[key] = deepMerge(
          targetValue,
          sourceValue as DeepPartial<typeof targetValue>
        );
      } else if (sourceValue !== undefined) {
        (output as any)[key] = sourceValue;
      }
    } else if (source[key as keyof DeepPartial<T>] !== undefined) {
      (output as any)[key] = source[key as keyof DeepPartial<T>];
    }
  });

  return output;
}
