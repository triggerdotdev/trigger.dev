import { EnvQueues, MarQSFairDequeueStrategy, MarQSKeyProducer } from "./types";

export type EnvPriorityDequeuingStrategyOptions = {
  keys: MarQSKeyProducer;
  delegate: MarQSFairDequeueStrategy;
};

export class EnvPriorityDequeuingStrategy implements MarQSFairDequeueStrategy {
  private _delegate: MarQSFairDequeueStrategy;

  constructor(private options: EnvPriorityDequeuingStrategyOptions) {
    this._delegate = options.delegate;
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<EnvQueues>> {
    const envQueues = await this._delegate.distributeFairQueuesFromParentQueue(
      parentQueue,
      consumerId
    );

    return this.#sortQueuesInEnvironmentsByPriority(envQueues);
  }

  #sortQueuesInEnvironmentsByPriority(envs: EnvQueues[]): EnvQueues[] {
    return envs.map((env) => {
      return this.#sortQueuesInEnvironmentByPriority(env);
    });
  }

  // Sorts the queues by priority. A higher priority means the queue should be dequeued first.
  // All the queues with the same priority should keep the order they were in the original list.
  // So that means if all the queues have the same priority, the order should be preserved.
  #sortQueuesInEnvironmentByPriority(env: EnvQueues): EnvQueues {
    const queues = env.queues;

    // Group queues by their base name (without priority)
    const queueGroups = new Map<string, string[]>();

    queues.forEach((queue) => {
      const descriptor = this.options.keys.queueDescriptorFromQueue(queue);
      const baseQueueName = this.options.keys.queueKey(
        descriptor.organization,
        descriptor.environment,
        descriptor.name,
        descriptor.concurrencyKey
      );

      if (!queueGroups.has(baseQueueName)) {
        queueGroups.set(baseQueueName, []);
      }

      queueGroups.get(baseQueueName)!.push(queue);
    });

    // For each group, keep only the highest priority queue
    const resultQueues: string[] = [];
    queueGroups.forEach((groupQueues) => {
      const sortedGroupQueues = [...groupQueues].sort((a, b) => {
        const aPriority = this.#getQueuePriority(a);
        const bPriority = this.#getQueuePriority(b);

        if (aPriority === bPriority) {
          return 0;
        }

        return bPriority - aPriority;
      });

      resultQueues.push(sortedGroupQueues[0]);
    });

    // Sort the final result by priority
    const sortedQueues = resultQueues.sort((a, b) => {
      const aPriority = this.#getQueuePriority(a);
      const bPriority = this.#getQueuePriority(b);

      if (aPriority === bPriority) {
        return 0;
      }

      return bPriority - aPriority;
    });

    return { envId: env.envId, queues: sortedQueues };
  }

  #getQueuePriority(queue: string): number {
    const queueRecord = this.options.keys.queueDescriptorFromQueue(queue);

    return queueRecord.priority ?? 0;
  }
}
