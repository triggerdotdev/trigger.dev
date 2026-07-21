// Load apps/webapp/.env into process.env so env.server's top-level
// EnvironmentSchema.parse(process.env) succeeds in vitest workers.
import { config } from "dotenv";
import path from "node:path";
import { vi } from "vitest";
import type * as IORedisModule from "ioredis";
import type * as TaskMetadataCacheModule from "~/services/taskMetadataCache.server";

config({ path: path.resolve(__dirname, "../.env") });

// CI has no .env and no REDIS_HOST/REDIS_PORT, so import-time guards like
// autoIncrementCounter.server.ts throw and their suites fail to collect. Default
// the pair — the ioredis mock below forces lazyConnect, so nothing ever dials.
process.env.REDIS_HOST ??= "localhost";
process.env.REDIS_PORT ??= "6379";
process.env.PROVIDER_SECRET ??= "test-provider-secret";
process.env.COORDINATOR_SECRET ??= "test-coordinator-secret";
process.env.MANAGED_WORKER_SECRET ??= "test-managed-worker-secret";

// Worker singletons construct a RedisWorker at import time whose ioredis client
// connects eagerly, so any test importing the service graph opens real Redis
// connections on import — which floods and fails in CI (no Redis). Mock them to
// no-op stubs. Only the worker modules are mocked, never the run store
// (~/v3/runStore.server, ~/db.server), which store-routing tests need real.
function createWorkerStub() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    enqueue: vi.fn().mockResolvedValue(undefined),
    enqueueOnce: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock("~/v3/commonWorker.server", () => ({ commonWorker: createWorkerStub() }));
vi.mock("~/v3/batchTriggerWorker.server", () => ({ batchTriggerWorker: createWorkerStub() }));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: createWorkerStub() }));

// RunEngine and the socket.io server are further singletons that open eager
// ioredis connections at import via the same pattern. No test
// uses these app-level singletons directly (store-routing tests build their own
// engine and run store), so stub them to no-op proxies.
// Recursive no-op proxy: property access at any depth returns another callable
// no-op proxy, so real service tests reaching nested singleton methods (e.g.
// engine.runQueue.updateEnvConcurrencyLimits) don't break on an intermediate stub.
type NoopProxyFn = ((...args: unknown[]) => Promise<undefined>) & Record<string, unknown>;

const noopProxy = (): NoopProxyFn => {
  const fn = () => Promise.resolve(undefined);
  return new Proxy(fn, {
    get: (_target, prop) => (prop === "then" ? undefined : noopProxy()),
    apply: () => Promise.resolve(undefined),
  }) as unknown as NoopProxyFn;
};

// Beyond the modules mocked above, dozens more app modules construct an
// ioredis client at import time pointed at env-configured Redis, and ioredis
// dials on construction — in CI (no Redis service) that floods ECONNREFUSED at
// shard scale. Force `lazyConnect: true` on every client instead: import-time
// singletons construct but never dial, while anything that actually issues a
// command (tests against live testcontainers) connects on first command
// exactly as before.
vi.mock("ioredis", async (importOriginal) => {
  const actual = await importOriginal<typeof IORedisModule>();

  // Normalize ioredis's overloaded ctor args — (), (port), (path),
  // (port, host), (opts), (port, opts), (port, host, opts), (path, opts) —
  // so lazyConnect lands in the options object in every form.
  function withLazyConnect(args: unknown[]): unknown[] {
    if (args.length === 0) {
      return [{ lazyConnect: true }];
    }
    const last = args[args.length - 1];
    if (typeof last === "object" && last !== null) {
      return [...args.slice(0, -1), { ...last, lazyConnect: true }];
    }
    return [...args, { lazyConnect: true }];
  }

  class LazyRedis extends actual.Redis {
    constructor(...args: unknown[]) {
      // @ts-expect-error – forwarding ioredis's overloaded ctor args
      super(...withLazyConnect(args));
    }
  }

  class LazyCluster extends actual.Cluster {
    constructor(startupNodes: unknown, options?: Record<string, unknown>) {
      // @ts-expect-error – forwarding ioredis's ctor args
      super(startupNodes, { ...options, lazyConnect: true });
    }
  }

  // Keep the `Redis.Cluster` static alias (`new Redis.Cluster(...)`) working.
  // The base class exposes `Cluster` as a getter-only static, so define our
  // own property rather than assigning through the inherited getter.
  Object.defineProperty(LazyRedis, "Cluster", { value: LazyCluster });

  return {
    ...actual,
    default: LazyRedis,
    Redis: LazyRedis,
    Cluster: LazyCluster,
  };
});

// alertsRateLimiter.check() is invoked at runtime by deliverAlert; against
// env-configured Redis each check burns ~20 reconnect cycles before its
// caught error, stalling alert-path tests into timeouts. Allow everything.
vi.mock("~/v3/alertsRateLimiter.server", () => ({
  alertsRateLimiter: { check: vi.fn().mockResolvedValue({ allowed: true }) },
}));

// tracePubSub.publish() runs inside eventRepository writes; each publish to
// env-configured Redis stalls ~20 reconnect cycles (errors are allSettled-
// swallowed but awaited), timing out any test that records trace events.
vi.mock("~/v3/services/tracePubSub.server", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    tracePubSub: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribeToTrace: vi.fn().mockResolvedValue({
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        eventEmitter: new EventEmitter(),
      }),
    },
    TracePubSub: class {},
  };
});

// Same runtime-stall shape for the task metadata cache (queues concern). CI
// leaves TASK_META_CACHE_REDIS_HOST unset and gets the Noop implementation;
// pin the Noop cache here so env-configured local runs behave identically.
vi.mock("~/services/taskMetadataCacheInstance.server", async () => {
  const { NoopTaskMetadataCache } = await vi.importActual<typeof TaskMetadataCacheModule>(
    "~/services/taskMetadataCache.server"
  );
  return { taskMetadataCacheInstance: new NoopTaskMetadataCache() };
});

// The org-data-stores registry singleton is constructed at import (transitively via
// the ClickHouse factory instance, which many presenters pull in). Its ctor fires a
// `forever` pRetry(loadFromDatabase) plus a setInterval reload against db.server's
// $replica; in CI (no Postgres) those retry forever, blocking the worker until any
// awaiting test's hook times out. Stub the instance to a no-op — no unit test uses
// this singleton (the registry-behavior tests construct the class directly).
vi.mock("~/services/dataStores/organizationDataStoresRegistryInstance.server", () => ({
  organizationDataStoresRegistry: {
    isReady: Promise.resolve(),
    isLoaded: true,
    get: vi.fn().mockReturnValue(null),
    reload: vi.fn().mockResolvedValue(undefined),
    loadFromDatabase: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("~/v3/runEngine.server", () => ({ engine: noopProxy() }));
vi.mock("~/v3/handleSocketIo.server", () => ({
  socketIo: noopProxy(),
  roomFromFriendlyRunId: (id: string) => `room:${id}`,
}));
