import { nanoid } from "nanoid";
import {
  MarQSQueuePriorityStrategy,
  PriorityStrategyChoice,
  QueueRange,
  QueueWithScores,
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

  moveToNextRange(
    parentQueue: string,
    consumerId: string,
    currentRange: QueueRange,
    parentQueueSize: number
  ): QueueRange {
    const nextRange: QueueRange = {
      offset: currentRange.offset + currentRange.count,
      count: currentRange.count,
    };

    // if the nextRange is within the parentQueueSize, set it on the this._nextRangesByParentQueue map and return it
    // if the nextRange is outside the parentQueueSize, reset the range to the beginning by deleting the entry from the map
    if (nextRange.offset < parentQueueSize) {
      this._nextRangesByParentQueue.set(`${consumerId}:${parentQueue}`, nextRange);
      return nextRange;
    } else {
      this._nextRangesByParentQueue.delete(`${consumerId}:${parentQueue}`);
      return { offset: 0, count: this.options.queueSelectionCount };
    }
  }

  distributeQueues(queues: QueueWithScores[]): Array<string> {
    const filteredQueues = filterQueuesAtCapacity(queues);

    if (filteredQueues.length === 0) {
      return [];
    }

    const queueWeights = this.#calculateQueueWeights(filteredQueues);

    // Sort queues by weight in descending order
    const sortedQueues = [...queueWeights].sort((a, b) => b.totalWeight - a.totalWeight);

    // Convert weights to probabilities
    const totalQueueWeight = sortedQueues.reduce((sum, queue) => sum + queue.totalWeight, 0);
    const weightedQueues = sortedQueues.map(({ queue, totalWeight }) => ({
      queue,
      probability: totalWeight / totalQueueWeight,
    }));

    // Apply some randomization while maintaining general weight order
    // This helps prevent all consumers from always picking the same highest-weight queue
    const shuffledWeightedQueues = weightedQueues
      .map((queueInfo, index) => ({
        ...queueInfo,
        // Add some controlled randomness while maintaining general weight order
        randomFactor: Math.random() * 0.2 - 0.1, // ±10% random adjustment
        originalIndex: index,
      }))
      .sort((a, b) => {
        // If probability difference is significant (>20%), maintain order
        if (Math.abs(a.probability - b.probability) > 0.2) {
          return b.probability - a.probability;
        }
        // Otherwise, allow some randomization while keeping similar weights roughly together
        return b.probability + b.randomFactor - (a.probability + a.randomFactor);
      })
      .map(({ queue }) => queue);

    return shuffledWeightedQueues;
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

export class NoopWeightedChoiceStrategy implements MarQSQueuePriorityStrategy {
  nextCandidateSelection(parentQueue: string): Promise<{ range: QueueRange; selectionId: string }> {
    return Promise.resolve({ range: { offset: 0, count: 0 }, selectionId: nanoid(24) });
  }

  distributeQueues(queues: Array<QueueWithScores>): Array<string> {
    return [];
  }

  moveToNextRange(
    parentQueue: string,
    consumerId: string,
    currentRange: QueueRange,
    queueSize: number
  ): QueueRange {
    return { offset: 0, count: 0 };
  }
}
