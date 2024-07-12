import { RedisOptions } from "ioredis";
import { nanoid } from "nanoid";
import {
  type MarQSQueuePriorityStrategy,
  type PriorityStrategyChoice,
  type QueueRange,
  type QueueWithScores,
} from "./types";

export type SimpleWeightedChoiceStrategyOptions = {
  queueSelectionCount: number;
  randomSeed?: string;
  excludeEnvCapacity?: boolean;
};

export class SimpleWeightedChoiceStrategy implements MarQSQueuePriorityStrategy {
  private _nextRangesByParentQueue: Map<string, QueueRange> = new Map();

  constructor(private options: SimpleWeightedChoiceStrategyOptions) {}

  private nextRangeForParentQueue(parentQueue: string, consumerId: string): QueueRange {
    return (
      this._nextRangesByParentQueue.get(`${consumerId}:${parentQueue}`) ?? {
        offset: 0,
        count: this.options.queueSelectionCount,
      }
    );
  }

  chooseQueue(
    queues: QueueWithScores[],
    parentQueue: string,
    consumerId: string,
    previousRange: QueueRange
  ): PriorityStrategyChoice {
    const filteredQueues = filterQueuesAtCapacity(queues);

    if (queues.length === this.options.queueSelectionCount) {
      const nextRange: QueueRange = {
        offset: previousRange.offset + this.options.queueSelectionCount,
        count: this.options.queueSelectionCount,
      };
      // If all queues are at capacity, and we were passed the max number of queues, then we will slide the window "to the right"
      this._nextRangesByParentQueue.set(`${consumerId}:${parentQueue}`, nextRange);
    } else {
      this._nextRangesByParentQueue.delete(`${consumerId}:${parentQueue}`);
    }

    if (filteredQueues.length === 0) {
      return { abort: true };
    }

    const queueWeights = this.#calculateQueueWeights(filteredQueues);

    return weightedRandomChoice(queueWeights);
  }

  async nextCandidateSelection(
    parentQueue: string,
    consumerId: string
  ): Promise<{ range: QueueRange }> {
    return {
      range: this.nextRangeForParentQueue(parentQueue, consumerId),
    };
  }

  #calculateQueueWeights(queues: QueueWithScores[]) {
    const avgQueueSize = queues.reduce((acc, { size }) => acc + size, 0) / queues.length;
    const avgMessageAge = queues.reduce((acc, { age }) => acc + age, 0) / queues.length;

    return queues.map(({ capacities, age, queue, size }) => {
      let totalWeight = 1;

      if (size > avgQueueSize) {
        totalWeight += Math.min(size / avgQueueSize, 4);
      }

      if (age > avgMessageAge) {
        totalWeight += Math.min(age / avgMessageAge, 4);
      }

      return {
        queue,
        totalWeight: age,
      };
    });
  }
}

function filterQueuesAtCapacity(queues: QueueWithScores[]) {
  return queues.filter(
    (queue) =>
      queue.capacities.queue.current < queue.capacities.queue.limit &&
      queue.capacities.env.current < queue.capacities.env.limit &&
      queue.capacities.org.current < queue.capacities.org.limit
  );
}

function weightedRandomChoice(queues: Array<{ queue: string; totalWeight: number }>) {
  const totalWeight = queues.reduce((acc, queue) => acc + queue.totalWeight, 0);
  let randomNum = Math.random() * totalWeight;

  for (const queue of queues) {
    if (randomNum < queue.totalWeight) {
      return queue.queue;
    }

    randomNum -= queue.totalWeight;
  }

  // If we get here, we should just return a random queue
  return queues[Math.floor(Math.random() * queues.length)].queue;
}

export class NoopWeightedChoiceStrategy implements MarQSQueuePriorityStrategy {
  chooseQueue(
    queues: QueueWithScores[],
    parentQueue: string,
    selectionId: string
  ): PriorityStrategyChoice {
    return { abort: true };
  }

  nextCandidateSelection(parentQueue: string): Promise<{ range: QueueRange; selectionId: string }> {
    return Promise.resolve({ range: { offset: 0, count: 0 }, selectionId: nanoid(24) });
  }
}
