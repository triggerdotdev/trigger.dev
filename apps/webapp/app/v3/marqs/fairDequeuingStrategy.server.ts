import { flattenAttributes } from "@trigger.dev/core/v3";
import { createCache, DefaultStatefulContext, Namespace, Cache as UnkeyCache } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import { randomUUID } from "crypto";
import { Redis } from "ioredis";
import { MarQSFairDequeueStrategy, MarQSKeyProducer } from "./types";
import seedrandom from "seedrandom";
import { Tracer } from "@opentelemetry/api";
import { startSpan } from "../tracing.server";

export type FairDequeuingStrategyOptions = {
  redis: Redis;
  keys: MarQSKeyProducer;
  defaultOrgConcurrency: number;
  defaultEnvConcurrency: number;
  parentQueueLimit: number;
  checkForDisabledOrgs: boolean;
  tracer: Tracer;
  seed?: string;
};

type FairQueueConcurrency = {
  current: number;
  limit: number;
};

type FairQueue = { id: string; age: number; org: string; env: string };

type FairQueueSnapshot = {
  id: string;
  orgs: Record<string, { concurrency: FairQueueConcurrency }>;
  envs: Record<string, { concurrency: FairQueueConcurrency }>;
  queues: Array<FairQueue>;
};

const emptyFairQueueSnapshot: FairQueueSnapshot = {
  id: "empty",
  orgs: {},
  envs: {},
  queues: [],
};

export class FairDequeuingStrategy implements MarQSFairDequeueStrategy {
  private _cache: UnkeyCache<{
    concurrencyLimit: number;
    disabledConcurrency: boolean;
  }>;

  private _rng: seedrandom.PRNG;

  constructor(private options: FairDequeuingStrategyOptions) {
    const ctx = new DefaultStatefulContext();
    const memory = new MemoryStore({ persistentMap: new Map() });

    this._cache = createCache({
      concurrencyLimit: new Namespace<number>(ctx, {
        stores: [memory],
        fresh: 60_000, // The time in milliseconds that a value is considered fresh. Cache hits within this time will return the cached value.
        stale: 180_000, // The time in milliseconds that a value is considered stale. Cache hits within this time will return the cached value and trigger a background refresh.
      }),
      disabledConcurrency: new Namespace<boolean>(ctx, {
        stores: [memory],
        fresh: 30_000, // The time in milliseconds that a value is considered fresh. Cache hits within this time will return the cached value.
        stale: 180_000, // The time in milliseconds that a value is considered stale. Cache hits within this time will return the cached value and trigger a background refresh.
      }),
    });

    this._rng = seedrandom(options.seed);
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<string>> {
    return await startSpan(
      this.options.tracer,
      "distributeFairQueuesFromParentQueue",
      async (span) => {
        span.setAttribute("consumer_id", consumerId);
        span.setAttribute("parent_queue", parentQueue);

        const snapshot = await this.#createQueueSnapshot(parentQueue, consumerId);

        span.setAttributes({
          snapshot_org_count: Object.keys(snapshot.orgs).length,
          snapshot_env_count: Object.keys(snapshot.envs).length,
          snapshot_queue_count: snapshot.queues.length,
        });

        const queues = snapshot.queues;

        if (queues.length === 0) {
          return [];
        }

        const shuffledQueues = this.#shuffleQueuesByEnv(snapshot);

        span.setAttribute("shuffled_queue_count", shuffledQueues.length);

        if (shuffledQueues[0]) {
          span.setAttribute("winning_env", this.options.keys.envIdFromQueue(shuffledQueues[0]));
          span.setAttribute("winning_org", this.options.keys.orgIdFromQueue(shuffledQueues[0]));
        }

        return shuffledQueues;
      }
    );
  }

  // Now we need to:
  // 1. Shuffle the environments
  // 2. Sort the queues by their environment order in the shuffled list
  // 3. Keep the queues sorted by their age inside their "environment" slice of the final array
  #shuffleQueuesByEnv(snapshot: FairQueueSnapshot): Array<string> {
    const envs = Object.keys(snapshot.envs);

    const shuffledEnvs = this.#shuffle(envs);

    const queuesByEnv = snapshot.queues.reduce((acc, queue) => {
      if (!acc[queue.env]) {
        acc[queue.env] = [];
      }

      acc[queue.env].push(queue);

      return acc;
    }, {} as Record<string, Array<FairQueue>>);

    const queues = shuffledEnvs.reduce((acc, envId) => {
      if (queuesByEnv[envId]) {
        acc.push(...queuesByEnv[envId].sort((a, b) => b.age - a.age));
      }

      return acc;
    }, [] as Array<FairQueue>);

    return queues.map((queue) => queue.id);
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

      const now = Date.now();

      const queues = await this.#allChildQueuesByScore(parentQueue, consumerId, now);

      span.setAttribute("parent_queue_count", queues.length);

      if (queues.length === 0) {
        return emptyFairQueueSnapshot;
      }

      const orgIds = new Set<string>();
      const envIds = new Set<string>();
      const envIdToOrgId = new Map<string, string>();

      for (const queue of queues) {
        orgIds.add(queue.org);
        envIds.add(queue.env);

        envIdToOrgId.set(queue.env, queue.org);
      }

      const orgs = await Promise.all(
        Array.from(orgIds).map(async (orgId) => {
          return { id: orgId, concurrency: await this.#getOrgConcurrency(orgId) };
        })
      );

      const orgsAtFullConcurrency = orgs.filter(
        (org) => org.concurrency.current >= org.concurrency.limit
      );

      span.setAttributes({
        ...flattenAttributes(orgsAtFullConcurrency, "orgs_at_full_concurrency"),
      });

      const orgIdsAtFullConcurrency = new Set(orgsAtFullConcurrency.map((org) => org.id));

      const orgsSnapshot = orgs.reduce((acc, org) => {
        if (!orgIdsAtFullConcurrency.has(org.id)) {
          acc[org.id] = org;
        }

        return acc;
      }, {} as Record<string, { concurrency: FairQueueConcurrency }>);

      if (Object.keys(orgsSnapshot).length === 0) {
        return emptyFairQueueSnapshot;
      }

      const envsWithoutFullOrgs = Array.from(envIds).filter(
        (envId) => !orgIdsAtFullConcurrency.has(envIdToOrgId.get(envId)!)
      );

      const envs = await Promise.all(
        envsWithoutFullOrgs.map(async (envId) => {
          return {
            id: envId,
            concurrency: await this.#getEnvConcurrency(envId, envIdToOrgId.get(envId)!),
          };
        })
      );

      const envsAtFullConcurrency = envs.filter(
        (env) => env.concurrency.current >= env.concurrency.limit
      );

      span.setAttributes({
        ...flattenAttributes(envsAtFullConcurrency, "envs_at_full_concurrency"),
      });

      const envIdsAtFullConcurrency = new Set(envsAtFullConcurrency.map((env) => env.id));

      const envsSnapshot = envs.reduce((acc, env) => {
        if (!envIdsAtFullConcurrency.has(env.id)) {
          acc[env.id] = env;
        }

        return acc;
      }, {} as Record<string, { concurrency: FairQueueConcurrency }>);

      const queuesSnapshot = queues.filter(
        (queue) =>
          !orgIdsAtFullConcurrency.has(queue.org) && !envIdsAtFullConcurrency.has(queue.env)
      );

      const snapshot = {
        id: randomUUID(),
        orgs: orgsSnapshot,
        envs: envsSnapshot,
        queues: queuesSnapshot,
      };

      return snapshot;
    });
  }

  async #getOrgConcurrency(orgId: string): Promise<FairQueueConcurrency> {
    return await startSpan(this.options.tracer, "getOrgConcurrency", async (span) => {
      span.setAttribute("org_id", orgId);

      if (this.options.checkForDisabledOrgs) {
        const isDisabled = await this.#getConcurrencyDisabled(orgId);

        if (isDisabled) {
          span.setAttribute("disabled", true);

          return { current: 0, limit: 0 };
        }
      }

      const [currentValue, limitValue] = await Promise.all([
        this.#getOrgCurrentConcurrency(orgId),
        this.#getOrgConcurrencyLimit(orgId),
      ]);

      span.setAttribute("current_value", currentValue);
      span.setAttribute("limit_value", limitValue);

      return { current: currentValue, limit: limitValue };
    });
  }

  async #getEnvConcurrency(envId: string, orgId: string): Promise<FairQueueConcurrency> {
    return await startSpan(this.options.tracer, "getEnvConcurrency", async (span) => {
      span.setAttribute("org_id", orgId);
      span.setAttribute("env_id", envId);

      const [currentValue, limitValue] = await Promise.all([
        this.#getEnvCurrentConcurrency(envId),
        this.#getEnvConcurrencyLimit(envId),
      ]);

      span.setAttribute("current_value", currentValue);
      span.setAttribute("limit_value", limitValue);

      return { current: currentValue, limit: limitValue };
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

      const valuesWithScores = await this.options.redis.zrangebyscore(
        parentQueue,
        "-inf",
        now,
        "WITHSCORES",
        "LIMIT",
        0,
        this.options.parentQueueLimit
      );

      const result: Array<FairQueue> = [];

      for (let i = 0; i < valuesWithScores.length; i += 2) {
        result.push({
          id: valuesWithScores[i],
          age: now - Number(valuesWithScores[i + 1]),
          env: this.options.keys.envIdFromQueue(valuesWithScores[i]),
          org: this.options.keys.orgIdFromQueue(valuesWithScores[i]),
        });
      }

      span.setAttribute("queue_count", result.length);

      return result;
    });
  }

  async #getConcurrencyDisabled(orgId: string) {
    return await startSpan(this.options.tracer, "getConcurrencyDisabled", async (span) => {
      span.setAttribute("org_id", orgId);

      const key = this.options.keys.disabledConcurrencyLimitKey(orgId);

      const result = await this._cache.disabledConcurrency.swr(key, async () => {
        const value = await this.options.redis.exists(key);

        return Boolean(value);
      });

      return typeof result.val === "boolean" ? result.val : false;
    });
  }

  async #getOrgConcurrencyLimit(orgId: string) {
    return await startSpan(this.options.tracer, "getOrgConcurrencyLimit", async (span) => {
      span.setAttribute("org_id", orgId);

      const key = this.options.keys.orgConcurrencyLimitKey(orgId);

      const result = await this._cache.concurrencyLimit.swr(key, async () => {
        const value = await this.options.redis.get(key);

        if (!value) {
          return this.options.defaultOrgConcurrency;
        }

        return Number(value);
      });

      return result.val ?? this.options.defaultOrgConcurrency;
    });
  }

  async #getOrgCurrentConcurrency(orgId: string) {
    return await startSpan(this.options.tracer, "getOrgCurrentConcurrency", async (span) => {
      span.setAttribute("org_id", orgId);

      const key = this.options.keys.orgCurrentConcurrencyKey(orgId);

      const result = await this.options.redis.scard(key);

      span.setAttribute("current_value", result);

      return result;
    });
  }

  async #getEnvConcurrencyLimit(envId: string) {
    return await startSpan(this.options.tracer, "getEnvConcurrencyLimit", async (span) => {
      span.setAttribute("env_id", envId);

      const key = this.options.keys.envConcurrencyLimitKey(envId);

      const result = await this._cache.concurrencyLimit.swr(key, async () => {
        const value = await this.options.redis.get(key);

        if (!value) {
          return this.options.defaultEnvConcurrency;
        }

        return Number(value);
      });

      return result.val ?? this.options.defaultEnvConcurrency;
    });
  }

  async #getEnvCurrentConcurrency(envId: string) {
    return await startSpan(this.options.tracer, "getEnvCurrentConcurrency", async (span) => {
      span.setAttribute("env_id", envId);

      const key = this.options.keys.envCurrentConcurrencyKey(envId);

      const result = await this.options.redis.scard(key);

      span.setAttribute("current_value", result);

      return result;
    });
  }
}

export class NoopFairDequeuingStrategy implements MarQSFairDequeueStrategy {
  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<Array<string>> {
    return [];
  }
}
