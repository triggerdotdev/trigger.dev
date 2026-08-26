import {
  createRedisClient,
  createRedisClusterClient,
  type RedisClient,
  type RedisOptions,
} from "@internal/redis";
import {
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  type RunStore,
} from "@internal/run-store";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { getSnapshotRepairEnqueuer } from "./snapshotStoreBindings.server";
import { snapshotStoreModeResolver } from "./snapshotStoreMode.server";
import { createSnapshotStoreMetrics } from "./snapshotStoreMetrics.server";
import { meter } from "./tracer.server";

const KEY_PREFIX = "engine:";

function isConfigured(): boolean {
  return !!env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST;
}

function redisOptions(): RedisOptions {
  return {
    keyPrefix: KEY_PREFIX,
    host: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST ?? undefined,
    port: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_PORT ?? undefined,
    username: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_USERNAME ?? undefined,
    password: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_PASSWORD ?? undefined,
    enableAutoPipelining: true,
    ...(env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };
}

function isClusterMode(): boolean {
  return env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_CLUSTER_MODE_ENABLED === "1";
}

function buildClient(name: string): RedisClient {
  const options = redisOptions();
  const onError = (error: Error) =>
    logger.error(`snapshot store redis client error (${name})`, { error });

  if (!isClusterMode()) {
    return createRedisClient(options, { onError });
  }

  return createRedisClusterClient(
    {
      nodes: [
        {
          host: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST,
          port: env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_PORT,
        },
      ],
      redisOptions: options,
    },
    { onError }
  );
}

type Instance = {
  sweepClient: RedisClient;
  hotPathClient: RedisClient;
  redisSnapshotStore: RedisSnapshotStore;
  decorate: (store: RunStore) => RunStore;
};

const instance = singleton<Instance | undefined>("snapshotStoreInstance", () => {
  if (!isConfigured()) {
    return undefined;
  }

  const metrics = createSnapshotStoreMetrics(meter);

  // The sweep gets a connection of its own so a full scan of every master can never stall a
  // transition append. It also backs the sweep's exclusion lock.
  const sweepClient = buildClient("sweep");

  const hotPathClient = buildClient("store");

  const redisSnapshotStore = new RedisSnapshotStore({
    client: hotPathClient,
    completedTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS,
    metrics: metrics.store,
  });

  return {
    sweepClient,
    hotPathClient,
    redisSnapshotStore,
    decorate: (store: RunStore) =>
      new TaskRunExecutionSnapshotStore(store, {
        store: redisSnapshotStore,
        modeResolver: snapshotStoreModeResolver,
        // Pinned: the field defaults to 0, which would mean no read ever reaches Redis. The
        // organisation is the ramp unit, so there is no percentage to ramp.
        readPercent: 100,
        metrics: metrics.decorator,
        onAppendFailure: async (args) => {
          const enqueue = getSnapshotRepairEnqueuer();
          if (!enqueue) {
            logger.error("snapshot repair enqueuer is unbound; repair job dropped", args);
            return;
          }
          await enqueue(args);
        },
      }),
  };
});

/** Returns the store verbatim when no snapshot-store Redis is configured. */
export function decorateWithSnapshotStore(store: RunStore): RunStore {
  return instance ? instance.decorate(store) : store;
}

export function getSnapshotSweepClient(): RedisClient | undefined {
  return instance?.sweepClient;
}

export function getSnapshotStoreConfig() {
  return {
    configured: isConfigured(),
    mode: snapshotStoreModeResolver.resolve(),
    completedTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS,
    orphanAgeMs: env.RUN_ENGINE_SNAPSHOT_STORE_ORPHAN_AGE_MS,
    keyPrefix: KEY_PREFIX,
    clusterMode: isClusterMode(),
  };
}

const extraQuits: (() => Promise<void>)[] = [];

/** Lets the wiring module hand back a teardown for what it built, so this owns closing everything. */
export function registerSnapshotStoreQuit(quit: () => Promise<void>): void {
  extraQuits.push(quit);
}

export async function quitSnapshotStoreClients(): Promise<void> {
  if (!instance) {
    return;
  }
  for (const quit of extraQuits) {
    await quit().catch(() => undefined);
  }
  await instance.sweepClient.quit().catch(() => undefined);
  // Last: an append in flight must still land. The store's own quit() returns early on a
  // caller-supplied client, so closing the socket is ours.
  await instance.redisSnapshotStore.quit().catch(() => undefined);
  await instance.hotPathClient.quit().catch(() => undefined);
}
