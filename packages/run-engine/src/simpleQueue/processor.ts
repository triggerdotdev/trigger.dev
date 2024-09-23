import { z } from "zod";
import { SimpleQueue } from "./index";

type QueueProcessorOptions<T extends z.ZodType> = {
  timeout?: number;
  retry?: {
    delay: {
      initial: number;
      max: number;
      factor: number;
    };
    maxAttempts: number;
  };
  onItem: (id: string, item: z.infer<T>) => Promise<void> | void;
};

export function createQueueProcessor<T extends z.ZodType>(
  queue: SimpleQueue<T>,
  options: QueueProcessorOptions<T>
) {
  const {
    timeout = 1000,
    retry = {
      delay: {
        initial: 1000,
        max: 10000,
        factor: 2,
      },
      maxAttempts: 10,
    },
    onItem,
  } = options;

  const failures = new Map<string, number>();
  let isRunning = false;

  async function processQueue() {
    if (!isRunning) return;

    const result = await queue.dequeue();
    if (result) {
      const { id, item } = result;
      try {
        await onItem(id, item);
      } catch (error) {
        console.error("Error processing item:", error);

        const retryCount = failures.get(id) || 0;
        if (retryCount >= retry.maxAttempts) {
          console.error(`SimpleQueue ${queue.name}: max attempts reached for item ${id}`, { item });
          return;
        }

        //requeue with delay
        const delay = Math.min(
          retry.delay.initial * Math.pow(retry.delay.factor, retryCount),
          retry.delay.max
        );
        console.log(`SimpleQueue ${queue.name}: requeueing item ${id} in ${delay}ms`, { item });
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
  }

  return {
    start: () => {
      if (!isRunning) {
        console.log("Starting queue processor...");
        isRunning = true;
        processQueue();
      } else {
        console.log("Queue processor is already running.");
      }
    },
    stop: () => {
      if (isRunning) {
        console.log("Stopping queue processor...");
        isRunning = false;
      } else {
        console.log("Queue processor is already stopped.");
      }
    },
  };
}
