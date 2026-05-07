import { createRedisClient, Redis, type RedisOptions } from "@internal/redis";
import { startSpan, type Tracer } from "@internal/tracing";
import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
  type UnkeyCache,
} from "@internal/cache";
import { randomUUID } from "crypto";
import seedrandom from "seedrandom";
import {
  EnvDescriptor,
  EnvQueues,
  RunQueueKeyProducer,
  RunQueueSelectionStrategy,
} from "./types.js";

export type FairQueueSelectionStrategyBiases = {
  /**
   * How much to bias towards environments with higher concurrency limits
   * 0 = no bias, 1 = full bias based on limit differences
   */
  concurrencyLimitBias: number;

  /**
   * How much to bias towards environments with more available capacity
   * 0 = no bias, 1 = full bias based on available capacity
   */
  availableCapacityBias: number;

  /**
   * Controls randomization of queue ordering within environments
   * 0 = strict age-based ordering (oldest first)
   * 1 = completely random ordering
   * Values between 0-1 blend between age-based and random ordering
   */
  queueAgeRandomization: number;
};

export type FairQueueSelectionStrategyOptions = {
  redis: RedisOptions;
  keys: RunQueueKeyProducer;
  defaultEnvConcurrencyLimit?: number;
  parentQueueLimit?: number;
  tracer?: Tracer;
  seed?: string;
  /**
   * Configure biasing for environment shuffling
   * If not provided, no biasing will be applied (completely random shuffling)
   */
  biases?: FairQueueSelectionStrategyBiases;
  reuseSnapshotCount?: number;
  maximumEnvCount?: number;
};

type FairQueueConcurrency = {
  current: number;
  limit: number;
};

type FairQueue = { id: string; age: number; org: string; env: string; project: string };

type FairQueueSnapshot = {
  id: string;
  envs: Record<string, { concurrency: FairQueueConcurrency }>;
  queues: Array<FairQueue>;
};

type WeightedEnv = {
  envId: string;
  weight: number;
};

type WeightedQueue = {
  queue: FairQueue;
  weight: number;
};

const emptyFairQueueSnapshot: FairQueueSnapshot = {
  id: "empty",
  envs: {},
  queues: [],
};

const defaultBiases: FairQueueSelectionStrategyBiases = {
  concurrencyLimitBias: 0,
  availableCapacityBias: 0,
  queueAgeRandomization: 0, // Default to completely age-based ordering
};

export class FairQueueSelectionStrategy implements RunQueueSelectionStrategy {
  private _cache: UnkeyCache<{
    concurrencyLimit: number;
  }>;

  private _rng: seedrandom.PRNG;
  private _reusedSnapshotForConsumer: Map<
    string,
    { snapshot: FairQueueSnapshot; reuseCount: number }
  > = new Map();
  private _redis: Redis;

  private _defaultEnvConcurrencyLimit: number;
  private _parentQueueLimit: number;

  constructor(private options: FairQueueSelectionStrategyOptions) {
    const ctx = new DefaultStatefulContext();
    const memory = createLRUMemoryStore(1000);

    this._cache = createCache({
      concurrencyLimit: new Namespace<number>(ctx, {
        stores: [memory],
        fresh: 60_000, // The time in milliseconds that a value is considered fresh. Cache hits within this time will return the cached value.
        stale: 180_000, // The time in milliseconds that a value is considered stale. Cache hits within this time will return the cached value and trigger a background refresh.
      }),
    });

    this._rng = seedrandom(options.seed);
    this._redis = createRedisClient(options.redis);

    this._defaultEnvConcurrencyLimit = options.defaultEnvConcurrencyLimit ?? 100;
    this._parentQueueLimit = options.parentQueueLimit ?? 100;
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<EnvQueues>> {
    return await startSpan(
      this.options.tracer,
      "distributeFairQueuesFromParentQueue",
      async (span) => {
        span.setAttribute("consumer_id", consumerId);
        span.setAttribute("parent_queue", parentQueue);

        const snapshot = await this.#createQueueSnapshot(parentQueue, consumerId);

        span.setAttributes({
          snapshot_env_count: Object.keys(snapshot.envs).length,
          snapshot_queue_count: snapshot.queues.length,
        });

        const queues = snapshot.queues;

        if (queues.length === 0) {
          return [];
        }

        const envQueues = this.#shuffleQueuesByEnv(snapshot);

        span.setAttribute(
          "shuffled_queue_count",
          envQueues.reduce((sum, env) => sum + env.queues.length, 0)
        );

        if (envQueues[0]?.queues[0]) {
          span.setAttribute("winning_env", envQueues[0].envId);
          span.setAttribute(
            "winning_org",
            this.options.keys.orgIdFromQueue(envQueues[0].queues[0])
          );
        }

        return envQueues;
      }
    );
  }

  #shuffleQueuesByEnv(snapshot: FairQueueSnapshot): Array<EnvQueues> {
    const envs = Object.keys(snapshot.envs);
    const biases = this.options.biases ?? defaultBiases;

    if (biases.concurrencyLimitBias === 0 && biases.availableCapacityBias === 0) {
      const shuffledEnvs = this.#shuffle(envs);
      return this.#orderQueuesByEnvs(shuffledEnvs, snapshot);
    }

    // Find the maximum concurrency limit for normalization
    const maxLimit = Math.max(...envs.map((envId) => snapshot.envs[envId].concurrency.limit));

    // Calculate weights for each environment
    const weightedEnvs: WeightedEnv[] = envs.map((envId) => {
      const env = snapshot.envs[envId];

      // Start with base weight of 1
      let weight = 1;

      // Add normalized concurrency limit bias if configured
      if (biases.concurrencyLimitBias > 0) {
        const normalizedLimit = env.concurrency.limit / maxLimit;
        // Square or cube the bias to make it more pronounced at higher values
        weight *= 1 + Math.pow(normalizedLimit * biases.concurrencyLimitBias, 2);
      }

      // Add available capacity bias if configured
      if (biases.availableCapacityBias > 0) {
        const usedCapacityPercentage = env.concurrency.current / env.concurrency.limit;
        const availableCapacityBonus = 1 - usedCapacityPercentage;
        // Square or cube the bias to make it more pronounced at higher values
        weight *= 1 + Math.pow(availableCapacityBonus * biases.availableCapacityBias, 2);
      }

      return { envId, weight };
    });

    const shuffledEnvs = this.#weightedShuffle(weightedEnvs);
    return this.#orderQueuesByEnvs(shuffledEnvs, snapshot);
  }

  #weightedShuffle(weightedItems: WeightedEnv[]): string[] {
    const totalWeight = weightedItems.reduce((sum, item) => sum + item.weight, 0);
    const result: string[] = [];
    const items = [...weightedItems];

    while (items.length > 0) {
      let random = this._rng() * totalWeight;
      let index = 0;

      // Find item based on weighted random selection
      while (random > 0 && index < items.length) {
        random -= items[index].weight;
        index++;
      }
      index = Math.max(0, index - 1);

      // Add selected item to result and remove from items
      result.push(items[index].envId);
      items.splice(index, 1);
    }

    return result;
  }

  // Helper method to maintain DRY principle
  // Update return type
  #orderQueuesByEnvs(envs: string[], snapshot: FairQueueSnapshot): Array<EnvQueues> {
    const queuesByEnv = snapshot.queues.reduce(
      (acc, queue) => {
        if (!acc[queue.env]) {
          acc[queue.env] = [];
        }
        acc[queue.env].push(queue);
        return acc;
      },
      {} as Record<string, Array<FairQueue>>
    );

    return envs.reduce((acc, envId) => {
      if (queuesByEnv[envId]) {
        // Get ordered queues for this env
        const orderedQueues = this.#weightedRandomQueueOrder(queuesByEnv[envId]);
        // Only add the env if it has queues
        if (orderedQueues.length > 0) {
          acc.push({
            envId,
            queues: orderedQueues.map((queue) => queue.id),
          });
        }
      }
      return acc;
    }, [] as Array<EnvQueues>);
  }

  #weightedRandomQueueOrder(queues: FairQueue[]): FairQueue[] {
    if (queues.length <= 1) return queues;

    const biases = this.options.biases ?? defaultBiases;

    // When queueAgeRandomization is 0, use strict age-based ordering
    if (biases.queueAgeRandomization === 0) {
      return [...queues].sort((a, b) => b.age - a.age);
    }

    // Find the maximum age for normalization
    const maxAge = Math.max(...queues.map((q) => q.age));

    // Calculate weights for each queue
    const weightedQueues: WeightedQueue[] = queues.map((queue) => {
      // Normalize age to be between 0 and 1
      const normalizedAge = queue.age / maxAge;

      // Calculate weight: combine base weight with configurable age influence
      const baseWeight = 1;
      const weight = baseWeight + normalizedAge * biases.queueAgeRandomization;

      return { queue, weight };
    });

    // Perform weighted random selection for ordering
    const result: FairQueue[] = [];
    let remainingQueues = [...weightedQueues];
    let totalWeight = remainingQueues.reduce((sum, wq) => sum + wq.weight, 0);

    while (remainingQueues.length > 0) {
      let random = this._rng() * totalWeight;
      let index = 0;

      // Find queue based on weighted random selection
      while (random > 0 && index < remainingQueues.length) {
        random -= remainingQueues[index].weight;
        index++;
      }
      index = Math.max(0, index - 1);

      // Add selected queue to result and remove from remaining
      result.push(remainingQueues[index].queue);
      totalWeight -= remainingQueues[index].weight;
      remainingQueues.splice(index, 1);
    }

    return result;
  }

  #shuffle<T>(array: Array<T>): Array<T> {
    let currentIndex = array.length;
    let temporaryValue;
    let randomIndex;

    const newArray = [...array];

    while (currentIndex !== 0) {
      randomIndex = Math.floor(this._rng() * currentIndex);
      currentIndex -= 1;

      temporaryValue = newArray[currentIndex];
      newArray[currentIndex] = newArray[randomIndex];
      newArray[randomIndex] = temporaryValue;
    }

    return newArray;
  }

  async #createQueueSnapshot(parentQueue: string, consumerId: string): Promise<FairQueueSnapshot> {
    return await startSpan(this.options.tracer, "createQueueSnapshot", async (span) => {
      span.setAttribute("consumer_id", consumerId);
      span.setAttribute("parent_queue", parentQueue);

      if (
        typeof this.options.reuseSnapshotCount === "number" &&
        this.options.reuseSnapshotCount > 0
      ) {
        const key = `${parentQueue}:${consumerId}`;
        const reusedSnapshot = this._reusedSnapshotForConsumer.get(key);

        if (reusedSnapshot) {
          if (reusedSnapshot.reuseCount < this.options.reuseSnapshotCount) {
            span.setAttribute("reused_snapshot", true);

            this._reusedSnapshotForConsumer.set(key, {
              snapshot: reusedSnapshot.snapshot,
              reuseCount: reusedSnapshot.reuseCount + 1,
            });

            return reusedSnapshot.snapshot;
          } else {
            this._reusedSnapshotForConsumer.delete(key);
          }
        }
      }

      span.setAttribute("reused_snapshot", false);

      const now = Date.now();

      let queues = await this.#allChildQueuesByScore(parentQueue, consumerId, now);

      span.setAttribute("parent_queue_count", queues.length);

      if (queues.length === 0) {
        return emptyFairQueueSnapshot;
      }

      // Apply env selection if maximumEnvCount is specified
      let selectedEnvIds: Set<string>;
      if (this.options.maximumEnvCount && this.options.maximumEnvCount > 0) {
        selectedEnvIds = this.#selectTopEnvs(queues, this.options.maximumEnvCount);
        // Filter queues to only include selected envs
        queues = queues.filter((queue) => selectedEnvIds.has(queue.env));

        span.setAttribute("selected_env_count", selectedEnvIds.size);
      }

      span.setAttribute("selected_queue_count", queues.length);

      const envIds = new Set<string>();
      const envIdToEnvDescriptor = new Map<string, EnvDescriptor>();

      for (const queue of queues) {
        envIds.add(queue.env);
        envIdToEnvDescriptor.set(queue.env, this.#envDescriptorFromFairQueue(queue));
      }

      const envs = await Promise.all(
        Array.from(envIds).map(async (envId) => {
          const envDescriptor = envIdToEnvDescriptor.get(envId);

          if (!envDescriptor) {
            throw new Error(`No env descriptor found for envId: ${envId}`);
          }

          return {
            id: envId,
            concurrency: await this.#getEnvConcurrency(envDescriptor),
          };
        })
      );

      const envsAtFullConcurrency = envs.filter(
        (env) => env.concurrency.current >= env.concurrency.limit
      );

      const envIdsAtFullConcurrency = new Set(envsAtFullConcurrency.map((env) => env.id));

      const envsSnapshot = envs.reduce(
        (acc, env) => {
          if (!envIdsAtFullConcurrency.has(env.id)) {
            acc[env.id] = env;
          }
          return acc;
        },
        {} as Record<string, { concurrency: FairQueueConcurrency }>
      );

      span.setAttributes({
        env_count: envs.length,
        envs_at_full_concurrency_count: envsAtFullConcurrency.length,
      });

      const queuesSnapshot = queues.filter((queue) => !envIdsAtFullConcurrency.has(queue.env));

      const snapshot = {
        id: randomUUID(),
        envs: envsSnapshot,
        queues: queuesSnapshot,
      };

      if (
        typeof this.options.reuseSnapshotCount === "number" &&
        this.options.reuseSnapshotCount > 0
      ) {
        this._reusedSnapshotForConsumer.set(`${parentQueue}:${consumerId}`, {
          snapshot,
          reuseCount: 0,
        });
      }

      return snapshot;
    });
  }

  #selectTopEnvs(queues: FairQueue[], maximumEnvCount: number): Set<string> {
    // Group queues by env
    const queuesByEnv = queues.reduce(
      (acc, queue) => {
        if (!acc[queue.env]) {
          acc[queue.env] = [];
        }
        acc[queue.env].push(queue);
        return acc;
      },
      {} as Record<string, FairQueue[]>
    );

    // Calculate average age for each env
    const envAverageAges = Object.entries(queuesByEnv).map(([envId, envQueues]) => {
      const averageAge = envQueues.reduce((sum, q) => sum + q.age, 0) / envQueues.length;
      return { envId, averageAge };
    });

    // Perform weighted shuffle based on average ages
    const maxAge = Math.max(...envAverageAges.map((e) => e.averageAge));
    const weightedEnvs = envAverageAges.map((env) => ({
      envId: env.envId,
      weight: env.averageAge / maxAge, // Normalize weights
    }));

    // Select top N envs using weighted shuffle
    const selectedEnvs = new Set<string>();
    let remainingEnvs = [...weightedEnvs];
    let totalWeight = remainingEnvs.reduce((sum, env) => sum + env.weight, 0);

    while (selectedEnvs.size < maximumEnvCount && remainingEnvs.length > 0) {
      let random = this._rng() * totalWeight;
      let index = 0;

      while (random > 0 && index < remainingEnvs.length) {
        random -= remainingEnvs[index].weight;
        index++;
      }
      index = Math.max(0, index - 1);

      selectedEnvs.add(remainingEnvs[index].envId);
      totalWeight -= remainingEnvs[index].weight;
      remainingEnvs.splice(index, 1);
    }

    return selectedEnvs;
  }

  async #getEnvConcurrency(env: EnvDescriptor): Promise<FairQueueConcurrency> {
    return await startSpan(this.options.tracer, "getEnvConcurrency", async (span) => {
      span.setAttribute("env_id", env.envId);
      span.setAttribute("org_id", env.orgId);
      span.setAttribute("project_id", env.projectId);

      const [currentValue, limitValue, limitBurstFactor] = await Promise.all([
        this.#getEnvCurrentConcurrency(env),
        this.#getEnvConcurrencyLimit(env),
        this.#getEnvConcurrencyLimitBurstFactor(env),
      ]);

      span.setAttribute("current_value", currentValue);
      span.setAttribute("limit_value", limitValue);
      span.setAttribute("limit_burst_factor", limitBurstFactor);

      const limit = Math.floor(limitValue * limitBurstFactor);

      return { current: currentValue, limit };
    });
  }

  async #allChildQueuesByScore(
    parentQueue: string,
    consumerId: string,
    now: number
  ): Promise<Array<FairQueue>> {
    return await startSpan(this.options.tracer, "allChildQueuesByScore", async (span) => {
      span.setAttribute("consumer_id", consumerId);
      span.setAttribute("parent_queue", parentQueue);

      const valuesWithScores = await this._redis.zrangebyscore(
        parentQueue,
        "-inf",
        now,
        "WITHSCORES",
        "LIMIT",
        0,
        this._parentQueueLimit
      );

      const result: Array<FairQueue> = [];

      for (let i = 0; i < valuesWithScores.length; i += 2) {
        result.push({
          id: valuesWithScores[i],
          age: now - Number(valuesWithScores[i + 1]),
          env: this.options.keys.envIdFromQueue(valuesWithScores[i]),
          org: this.options.keys.orgIdFromQueue(valuesWithScores[i]),
          project: this.options.keys.projectIdFromQueue(valuesWithScores[i]),
        });
      }

      span.setAttribute("queue_count", result.length);

      return result;
    });
  }

  async #getEnvConcurrencyLimit(env: EnvDescriptor) {
    return await startSpan(this.options.tracer, "getEnvConcurrencyLimit", async (span) => {
      span.setAttribute("env_id", env.envId);

      const key = this.options.keys.envConcurrencyLimitKey(env);

      const result = await this._cache.concurrencyLimit.swr(key, async () => {
        const value = await this._redis.get(key);

        if (!value) {
          return this._defaultEnvConcurrencyLimit;
        }

        return Number(value);
      });

      return result.val ?? this._defaultEnvConcurrencyLimit;
    });
  }

  async #getEnvCurrentConcurrency(env: EnvDescriptor) {
    return await startSpan(this.options.tracer, "getEnvCurrentConcurrency", async (span) => {
      span.setAttribute("env_id", env.envId);
      span.setAttribute("org_id", env.orgId);
      span.setAttribute("project_id", env.projectId);

      const key = this.options.keys.envCurrentConcurrencyKey(env);

      const result = await this._redis.scard(key);

      span.setAttribute("current_value", result);

      return result;
    });
  }

  async #getEnvConcurrencyLimitBurstFactor(env: EnvDescriptor) {
    return await startSpan(
      this.options.tracer,
      "getEnvConcurrencyLimitBurstFactor",
      async (span) => {
        span.setAttribute("env_id", env.envId);
        span.setAttribute("org_id", env.orgId);
        span.setAttribute("project_id", env.projectId);

        const key = this.options.keys.envConcurrencyLimitBurstFactorKey(env);

        const result = await this._redis.get(key);

        if (typeof result === "string") {
          return Number(result);
        }

        return 1;
      }
    );
  }

  #envDescriptorFromFairQueue(queue: FairQueue): EnvDescriptor {
    return {
      envId: queue.env,
      projectId: queue.project,
      orgId: queue.org,
    };
  }
}

export class NoopFairDequeuingStrategy implements RunQueueSelectionStrategy {
  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<EnvQueues>> {
    return [];
  }
}
