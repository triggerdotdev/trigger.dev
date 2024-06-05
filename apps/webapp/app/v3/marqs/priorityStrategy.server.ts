import { RedisOptions } from "ioredis";
import {
  MarQSQueuePriorityStrategy,
  PriorityStrategyChoice,
  QueueRange,
  QueueWithScores,
} from "./types";
import { nanoid } from "nanoid";
import seedrandom from "seedrandom";

export type DynamicWeightedChoiceStrategyOptions = {
  initialQueueSelectionSize: number;
  redis: RedisOptions;
};

// This implementation of the priority strategy will "react" over time, giving more weight to queues that have been selected less frequently.
// It will also change the next candidate selection range based on if previous choices only had queues that were at capacity.
// Some other ideas:
// - Implement a "cooldown" period for queues that have been selected recently
// - Implement a "decay" for queues that have been selected recently
//
// The "memory" of this strategy is stored in Redis, to coordinate between multiple instances of the webapp (coming soon?)
export class DynamicWeightedChoiceStrategy implements MarQSQueuePriorityStrategy {
  constructor(private options: DynamicWeightedChoiceStrategyOptions) {}

  chooseQueue(
    queues: QueueWithScores[],
    parentQueue: string,
    selectionId: string
  ): PriorityStrategyChoice {
    throw new Error("Method not implemented.");
  }

  nextCandidateSelection(parentQueue: string): Promise<{ range: QueueRange; selectionId: string }> {
    throw new Error("Method not implemented.");
  }
}

export type SimpleWeightedChoiceStrategyOptions = {
  queueSelectionCount: number;
  randomSeed?: string;
};

export class SimpleWeightedChoiceStrategy implements MarQSQueuePriorityStrategy {
  private _nextRangesByParentQueue: Map<string, QueueRange> = new Map();
  private _randomGenerator = seedrandom(this.options.randomSeed);

  constructor(private options: SimpleWeightedChoiceStrategyOptions) {}

  private nextRangeForParentQueue(parentQueue: string): QueueRange {
    return (
      this._nextRangesByParentQueue.get(parentQueue) ?? {
        offset: 0,
        count: this.options.queueSelectionCount,
      }
    );
  }

  chooseQueue(
    queues: QueueWithScores[],
    parentQueue: string,
    selectionId: string
  ): PriorityStrategyChoice {
    const filteredQueues = filterQueuesAtCapacity(queues);

    if (queues.length === this.options.queueSelectionCount) {
      const nextRangeForParentQueue = this.nextRangeForParentQueue(parentQueue);
      const nextRange: QueueRange = nextRangeForParentQueue
        ? {
            offset: nextRangeForParentQueue.offset + this.options.queueSelectionCount,
            count: this.options.queueSelectionCount,
          }
        : { offset: this.options.queueSelectionCount, count: this.options.queueSelectionCount };
      // If all queues are at capacity, and we were passed the max number of queues, then we will slide the window "to the right"
      this._nextRangesByParentQueue.set(parentQueue, nextRange);
    } else {
      this._nextRangesByParentQueue.delete(parentQueue);
    }

    if (filteredQueues.length === 0) {
      return { abort: true };
    }

    const queueWeights = this.#calculateQueueWeights(filteredQueues);

    return weightedRandomChoice(queueWeights, this._randomGenerator());
  }

  async nextCandidateSelection(
    parentQueue: string
  ): Promise<{ range: QueueRange; selectionId: string }> {
    return { range: this.nextRangeForParentQueue(parentQueue), selectionId: nanoid(24) };
  }

  // This function calculates the weight of each queue based on the age of the queue and the capacity of the queue, env, and org
  // First, it normalizes the age, queue capacity, env capacity, and org capacity to a value between 0 and 1 based on the maximum value of each
  // Then, it calculates the weight of each queue based on the following factors:
  // - Age is 50% of the weight
  // - Queue capacity is 30% of the weight
  // - Env capacity is 10% of the weight
  // - Org capacity is 10% of the weight
  #calculateQueueWeights(queues: QueueWithScores[]) {
    const maximumAge = Math.max(...queues.map((queue) => queue.age));
    const maximumQueueCapacity = Math.max(
      ...queues.map((queue) => queue.capacities.queue.limit - queue.capacities.queue.current)
    );
    const maximumEnvCapacity = Math.max(
      ...queues.map((queue) => queue.capacities.env.limit - queue.capacities.env.current)
    );
    const maximumOrgCapacity = Math.max(
      ...queues.map((queue) => queue.capacities.org.limit - queue.capacities.org.current)
    );

    return queues.map(({ capacities, age, queue }) => {
      const ageWeight = 0.5 * (age / maximumAge);
      const queueWeight =
        0.3 * (1 - (capacities.queue.limit - capacities.queue.current) / maximumQueueCapacity);
      const envWeight =
        0.1 * (1 - (capacities.env.limit - capacities.env.current) / maximumEnvCapacity);
      const orgWeight =
        0.1 * (1 - (capacities.org.limit - capacities.org.current) / maximumOrgCapacity);

      return {
        queue,
        weight: ageWeight + queueWeight + envWeight + orgWeight,
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

function weightedRandomChoice(
  queues: Array<{ queue: string; weight: number }>,
  randomNumber: number
) {
  const totalWeight = queues.reduce((acc, queue) => acc + queue.weight, 0);
  const randomNum = randomNumber * totalWeight;
  let weightSum = 0;

  for (const queue of queues) {
    weightSum += queue.weight;
    if (randomNum <= weightSum) {
      return queue.queue;
    }
  }

  return queues[queues.length - 1].queue;
}
