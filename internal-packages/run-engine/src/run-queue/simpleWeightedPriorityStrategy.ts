import {
  RunQueuePriorityStrategy,
  PriorityStrategyChoice,
  QueueRange,
  QueueWithScores,
} from "./types.js";

export type SimpleWeightedChoiceStrategyOptions = {
  queueSelectionCount: number;
  randomSeed?: string;
  excludeEnvCapacity?: boolean;
};

export class SimpleWeightedChoiceStrategy implements RunQueuePriorityStrategy {
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

  chooseQueues(
    queues: QueueWithScores[],
    parentQueue: string,
    consumerId: string,
    previousRange: QueueRange,
    maxCount: number
  ): { choices: PriorityStrategyChoice; nextRange: QueueRange } {
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
      return {
        choices: { abort: true },
        nextRange: this.nextRangeForParentQueue(parentQueue, consumerId),
      };
    }

    const queueWeights = this.#calculateQueueWeights(filteredQueues);

    const choices = [];
    for (let i = 0; i < maxCount; i++) {
      const chosenIndex = weightedRandomIndex(queueWeights);

      const choice = queueWeights.at(chosenIndex)?.queue;
      if (choice) {
        queueWeights.splice(chosenIndex, 1);
        choices.push(choice);
      }
    }

    return {
      choices,
      nextRange: this.nextRangeForParentQueue(parentQueue, consumerId),
    };
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
      queue.capacities.env.current < queue.capacities.env.limit
  );
}

function weightedRandomIndex(queues: Array<{ queue: string; totalWeight: number }>): number {
  const totalWeight = queues.reduce((acc, queue) => acc + queue.totalWeight, 0);
  let randomNum = Math.random() * totalWeight;

  for (let i = 0; i < queues.length; i++) {
    const queue = queues[i];
    if (randomNum < queue.totalWeight) {
      return i;
    }

    randomNum -= queue.totalWeight;
  }

  // If we get here, we should just return a random queue
  return Math.floor(Math.random() * queues.length);
}
