import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
import Redis, { type RedisOptions } from "ioredis";
import path from "path";
import { type StartedNetwork, Network } from "testcontainers";
import { type TestContext, test } from "vitest";
import {
  type StartedClickHouseContainer,
  ClickHouseContainer,
  runClickhouseMigrations,
  truncateClickhouseTables,
} from "./clickhouse";
import { createDbBlipController, type DbBlipController } from "./dbBlip";
import { getTaskMetadata, logCleanup, logSetup } from "./logs";
import { type MinIOConnectionConfig, type StartedMinIOContainer, MinIOContainer } from "./minio";
import {
  createClickHouseContainer,
  createElectricContainer,
  createPostgresContainer,
  createRedisContainer,
  postgresUriWithDatabase,
  useContainer,
  withCiResourceLimits,
  withContainerSetup,
} from "./utils";
import {
  cloneDatabase,
  dropDatabase,
  getSharedPostgres14,
  getSharedPostgres17,
  getPrivatePostgres14,
  getSharedRunOpsPostgres17,
  type SharedPostgres,
  withClonedDatabase,
} from "./sharedPostgres";

export {
  assertNonNullable,
  createPostgresContainer,
  createStandalonePostgresContainer,
} from "./utils";
export { OtelCollectorContainer, StartedOtelCollectorContainer } from "./otelCollector";
export { laggingReplica, type LaggingModel } from "./laggingReplica";
export { createDbBlipController, type DbBlipController, type DbBlipHandle } from "./dbBlip";
export {
  hasLocalRedisServer,
  startLocalRedisCluster,
  type LocalRedisCluster,
} from "./localRedisCluster";
export { logCleanup };
export { warmSharedPostgres } from "./sharedPostgres";
export type { MinIOConnectionConfig };

type NetworkContext = { network: StartedNetwork };

type PostgresContext = NetworkContext & {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
};

type RedisContext = NetworkContext & {
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
};

type ElectricContext = {
  electricOrigin: string;
};

export type ContainerContext = NetworkContext & PostgresContext & RedisContext & ClickhouseContext;
export type PostgresAndRedisContext = NetworkContext & PostgresContext & RedisContext;
export type ContainerWithElectricAndRedisContext = ContainerContext & ElectricContext;
export type ContainerWithElectricContext = NetworkContext & PostgresContext & ElectricContext;

export type {
  StartedClickHouseContainer,
  StartedMinIOContainer,
  StartedNetwork,
  StartedPostgreSqlContainer,
  StartedRedisContainer,
};

export { MinIOContainer };

type Use<T> = (value: T) => Promise<void>;

export const network = async ({ task }: TestContext, use: Use<StartedNetwork>) => {
  const testName = task.name;

  logSetup("network: starting", { testName });

  const start = Date.now();
  const network = await new Network().start();
  const startDurationMs = Date.now() - start;

  const metadata = {
    ...getTaskMetadata(task),
    networkId: network.getId().slice(0, 12),
    networkName: network.getName(),
    startDurationMs,
  };

  logSetup("network: started", metadata);

  try {
    await use(network);
  } finally {
    await logCleanup("network", network.stop(), metadata);
  }
};

export const postgresContainer = async (
  { network, task }: { network: StartedNetwork } & TestContext,
  use: Use<StartedPostgreSqlContainer>
) => {
  const { container, metadata: _metadata } = await withContainerSetup({
    name: "postgresContainer",
    task,
    setup: createPostgresContainer(network),
  });

  await useContainer("postgresContainer", { container, task, use: () => use(container) });
};

export const prisma = async (
  { postgresContainer, task }: { postgresContainer: StartedPostgreSqlContainer } & TestContext,
  use: Use<PrismaClient>
) => {
  const testName = task.name;
  const url = postgresContainer.getConnectionUri();

  console.log("Initializing Prisma with URL:", url);

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
  });
  try {
    await use(prisma);
  } finally {
    await logCleanup("prisma", prisma.$disconnect(), { testName });
  }
};

type PostgresTestContext = {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
};

// --- Heterogeneous PG14 + PG17 fixture ---
// `und-x-icu` is a predefined ICU collation available by default in BOTH PG14 and PG17, so it is the
// version-symmetric per-column source of truth for cross-version sort equality.
export const HETERO_PINNED_ICU_COLLATION = "und-x-icu";

const clonedContainerFrom =
  (getPostgres: () => Promise<SharedPostgres>) =>
  async ({}, use: Use<StartedPostgreSqlContainer>) => {
    const shared = await getPostgres();
    const cloneDb = await cloneDatabase(shared, "test");
    const cloneUri = postgresUriWithDatabase(shared.container.getConnectionUri(), cloneDb);
    const view = new Proxy(shared.container, {
      get(target, prop, receiver) {
        if (prop === "getConnectionUri") return () => cloneUri;
        if (prop === "getDatabase") return () => cloneDb;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    try {
      await use(view);
    } finally {
      await dropDatabase(shared, cloneDb);
    }
  };

const clonedPostgresContainer = clonedContainerFrom(getSharedPostgres14);

const schemaOnlyPrismaFixture = async ({}: {}, use: Use<PrismaClient>) =>
  withClonedDatabase(getSharedPostgres14(), "schema_only", async (url) => {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    try {
      await use(prisma);
    } finally {
      await logCleanup("schemaOnlyPrisma", prisma.$disconnect());
    }
  });

const prismaFromContainer = async (
  { postgresContainer }: { postgresContainer: StartedPostgreSqlContainer },
  use: Use<PrismaClient>
) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: postgresContainer.getConnectionUri() } },
  });
  try {
    await use(prisma);
  } finally {
    await logCleanup("prisma", prisma.$disconnect());
  }
};

const CONTAINER_WARMUP_TIMEOUT_MS = 300_000;

type WarmableTestApi = {
  beforeAll: (fn: (context: any) => Promise<void>, timeout?: number) => void;
};

const withWarmup = <T extends WarmableTestApi>(
  api: T,
  warmUp: (context: any) => Promise<void>
): T => {
  const register = () => {
    api.beforeAll(warmUp, CONTAINER_WARMUP_TIMEOUT_MS);
  };

  return new Proxy(api, {
    apply(target, thisArg, args) {
      register();
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop !== "then") {
        // awaiting the module is not use
        register();
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
};

export const postgresTest = withWarmup(
  test.extend<PostgresTestContext>({
    postgresContainer: clonedPostgresContainer,
    prisma: prismaFromContainer,
  }),
  async () => {
    await getSharedPostgres14();
  }
);

export type PostgresBlipTestContext = PostgresTestContext & { blip: DbBlipController };

// Blip tests run against the pg driver adapter (PrismaPg + pg.Pool), not the default Rust engine:
// production uses the adapter, and only the adapter's pool reconnects transparently after a severed
// connection, so a retried statement lands on a fresh connection. The Rust engine reuses the dead
// one for a bare statement, which the adapter path never does.
const blipPrismaFromContainer = async (
  { postgresContainer }: { postgresContainer: StartedPostgreSqlContainer },
  use: Use<PrismaClient>
) => {
  const pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });
  // A severed connection surfaces asynchronously as an 'error' on the pool and on the checked-out
  // client; swallow both so a deliberately induced blip can't crash the test worker before the pool
  // replaces the connection. The query itself still rejects, which is what the retry path observes.
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await use(prisma);
  } finally {
    await logCleanup("blipPrisma", prisma.$disconnect());
    await logCleanup("blipPool", pool.end());
  }
};

const blipFromContainer = async (
  { postgresContainer }: { postgresContainer: StartedPostgreSqlContainer } & TestContext,
  use: Use<DbBlipController>
) => {
  const handle = await createDbBlipController(postgresContainer.getConnectionUri());
  try {
    await use(handle);
  } finally {
    await handle.close();
  }
};

// postgresTest + a DbBlipController bound to the same per-test database.
export const postgresBlipTest = withWarmup(
  test.extend<PostgresBlipTestContext>({
    postgresContainer: clonedPostgresContainer,
    prisma: blipPrismaFromContainer,
    blip: blipFromContainer,
  }),
  async () => {
    await getSharedPostgres14();
  }
);

type HeteroPostgresTestContext = {
  // PG14 (legacy / control-plane DB analog)
  postgresContainer14: StartedPostgreSqlContainer;
  prisma14: PrismaClient;
  uri14: string;
  // PG17 (new / dedicated run-ops DB analog)
  postgresContainer17: StartedPostgreSqlContainer;
  prisma17: PrismaClient;
  uri17: string;
  pinnedCollation: string; // === HETERO_PINNED_ICU_COLLATION
};

// Hands a test two prisma clients + two connection URIs (one PG14, one PG17) over the same migrated
// schema, each on a fresh per-test clone of its version's template. Consumed only by explicit
// cross-version test files - never wired into a product fixture.
export const heteroPostgresTest = test.extend<HeteroPostgresTestContext>({
  postgresContainer14: async ({}, use) => {
    await use((await getSharedPostgres14()).container);
  },
  postgresContainer17: async ({}, use) => {
    await use((await getSharedPostgres17()).container);
  },
  uri14: async ({}, use) => {
    await withClonedDatabase(getSharedPostgres14(), "hetero14", use);
  },
  uri17: async ({}, use) => {
    await withClonedDatabase(getSharedPostgres17(), "hetero17", use);
  },
  prisma14: async ({ uri14 }, use) => {
    const prisma = new PrismaClient({ datasources: { db: { url: uri14 } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
  prisma17: async ({ uri17 }, use) => {
    const prisma = new PrismaClient({ datasources: { db: { url: uri17 } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
  pinnedCollation: async ({}, use) => {
    await use(HETERO_PINNED_ICU_COLLATION);
  },
});

type HeteroRunOpsPostgresTestContext = {
  // PG14 (legacy / control-plane DB analog) — full @trigger.dev/database control-plane schema.
  postgresContainer14: StartedPostgreSqlContainer;
  prisma14: PrismaClient;
  uri14: string;
  // PG17 (new / dedicated run-ops DB) — the @internal/run-ops-database SUBSET schema.
  postgresContainer17: StartedPostgreSqlContainer;
  prisma17: RunOpsPrismaClient;
  uri17: string;
};

// Additive sibling of heteroPostgresTest for the dedicated run-ops migration: prisma14 is the full
// control-plane schema on PG14 (legacy), prisma17 is a RunOpsPrismaClient over the dedicated SUBSET
// schema on a SEPARATE PG17 container. Lets a test prove the two sides carry different schemas
// without disturbing the existing heteroPostgresTest (which keeps the full schema on both sides).
// The six hetero run-ops fixtures, shared by heteroRunOpsPostgresTest and heteroRunOpsWithRedisTest
// so the two cannot drift.
const heteroRunOpsFixtures = {
  postgresContainer14: async ({}, use: Use<StartedPostgreSqlContainer>) => {
    await use((await getSharedPostgres14()).container);
  },
  postgresContainer17: async ({}, use: Use<StartedPostgreSqlContainer>) => {
    await use((await getSharedRunOpsPostgres17()).container);
  },
  uri14: async ({}: {}, use: Use<string>) => {
    await withClonedDatabase(getSharedPostgres14(), "heteroRunOps14", use);
  },
  uri17: async ({}: {}, use: Use<string>) => {
    await withClonedDatabase(getSharedRunOpsPostgres17(), "heteroRunOps17", use);
  },
  prisma14: async ({ uri14 }: { uri14: string }, use: Use<PrismaClient>) => {
    const prisma = new PrismaClient({ datasources: { db: { url: uri14 } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
  prisma17: async ({ uri17 }: { uri17: string }, use: Use<RunOpsPrismaClient>) => {
    const prisma = new RunOpsPrismaClient({ datasources: { db: { url: uri17 } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
} as const;

export const heteroRunOpsPostgresTest = test.extend<HeteroRunOpsPostgresTestContext>({
  ...heteroRunOpsFixtures,
});

export type HeteroRunOpsBlipTestContext = {
  postgresContainer14: StartedPostgreSqlContainer;
  postgresContainer17: StartedPostgreSqlContainer;
  uri14: string;
  uri17: string;
  prisma14: PrismaClient;
  prisma17: RunOpsPrismaClient;
  blip14: DbBlipController;
  blip17: DbBlipController;
};

// heteroRunOpsPostgresTest but each client is adapter-backed (PrismaPg + pg.Pool) and paired with a
// DbBlipController, so a routing (RunOpsStore) test can sever EITHER run-ops database mid-statement
// and prove the cross-DB read/hydration retry recovers on the prod runtime.
export const heteroRunOpsBlipTest = withWarmup(
  test.extend<HeteroRunOpsBlipTestContext>({
    postgresContainer14: heteroRunOpsFixtures.postgresContainer14,
    postgresContainer17: heteroRunOpsFixtures.postgresContainer17,
    uri14: heteroRunOpsFixtures.uri14,
    uri17: heteroRunOpsFixtures.uri17,
    prisma14: async ({ uri14 }: { uri14: string }, use: Use<PrismaClient>) => {
      const pool = new Pool({ connectionString: uri14 });
      pool.on("error", () => {});
      pool.on("connect", (client) => client.on("error", () => {}));
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      try {
        await use(prisma);
      } finally {
        await logCleanup("heteroBlipPrisma14", prisma.$disconnect());
        await logCleanup("heteroBlipPool14", pool.end());
      }
    },
    prisma17: async ({ uri17 }: { uri17: string }, use: Use<RunOpsPrismaClient>) => {
      const pool = new Pool({ connectionString: uri17 });
      pool.on("error", () => {});
      pool.on("connect", (client) => client.on("error", () => {}));
      const prisma = new RunOpsPrismaClient({ adapter: new PrismaPg(pool) });
      try {
        await use(prisma);
      } finally {
        await logCleanup("heteroBlipPrisma17", prisma.$disconnect());
        await logCleanup("heteroBlipPool17", pool.end());
      }
    },
    blip14: async ({ uri14 }: { uri14: string }, use: Use<DbBlipController>) => {
      const handle = await createDbBlipController(uri14);
      try {
        await use(handle);
      } finally {
        await handle.close();
      }
    },
    blip17: async ({ uri17 }: { uri17: string }, use: Use<DbBlipController>) => {
      const handle = await createDbBlipController(uri17);
      try {
        await use(handle);
      } finally {
        await handle.close();
      }
    },
  }),
  async () => {
    await getSharedPostgres14();
    await getSharedRunOpsPostgres17();
  }
);

type ThreeDbRunOpsPostgresTestContext = {
  // Control-plane DB — full @trigger.dev/database schema.
  controlPlanePrisma: PrismaClient;
  controlPlaneUri: string;
  // Legacy runs DB — full @trigger.dev/database schema, its OWN physical database (a separate clone),
  // proving Track 2's independent legacy client is no longer an alias of the control-plane DB.
  legacyPrisma: PrismaClient;
  legacyUri: string;
  // New runs DB — the @internal/run-ops-database SUBSET schema on a separate PG17 container.
  newPrisma: RunOpsPrismaClient;
  newUri: string;
};

// Track 2 three-database topology: control-plane, legacy, and new are three DISTINCT physical
// databases. Control-plane and legacy both carry the full control-plane schema (two separate clones of
// the PG14 template), new carries the dedicated run-ops subset (a clone of the PG17 run-ops template).
// Lets a test prove routed run reads/writes land on the LEGACY DB (cuid) vs the NEW DB (run-ops id)
// while control-plane-model access stays on its own DB.
export const threeDbRunOpsPostgresTest = test.extend<ThreeDbRunOpsPostgresTestContext>({
  controlPlaneUri: async ({}, use) => {
    await withClonedDatabase(getSharedPostgres14(), "threeDbCp", use);
  },
  legacyUri: async ({}, use) => {
    await withClonedDatabase(getSharedPostgres14(), "threeDbLegacy", use);
  },
  newUri: async ({}, use) => {
    await withClonedDatabase(getSharedRunOpsPostgres17(), "threeDbNew", use);
  },
  controlPlanePrisma: async ({ controlPlaneUri }, use) => {
    const prisma = new PrismaClient({ datasources: { db: { url: controlPlaneUri } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
  legacyPrisma: async ({ legacyUri }, use) => {
    const prisma = new PrismaClient({ datasources: { db: { url: legacyUri } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
  newPrisma: async ({ newUri }, use) => {
    const prisma = new RunOpsPrismaClient({ datasources: { db: { url: newUri } } });
    try {
      await use(prisma);
    } finally {
      await prisma.$disconnect();
    }
  },
});

type NShardRunOpsTestContext = {
  // Legacy (PG14, full control-plane schema) — the gen-1 cuid store.
  legacyPrisma: PrismaClient;
  legacyUri: string;
  // The gen-1 "new" dedicated-subset store (PG17).
  newPrisma: RunOpsPrismaClient;
  newUri: string;
  // The gen-2 shards, each a dedicated-subset PG17 clone on its OWN database.
  shardPrismas: RunOpsPrismaClient[];
  shardUris: string[];
};

// Legacy (PG14 full schema) + `new` + `gen2ShardCount` gen-2 shards, each a dedicated-subset PG17
// clone and each its OWN database. Every store MUST be a distinct database, or the router's sum
// sites count one twice. Vitest test.extend keys are static, so the gen-2 clones arrive as arrays.
// threeDbRunOpsPostgresTest is control-plane/legacy/new — NOT run shards — so it cannot be reused.
export const makeNShardRunOpsPostgresTest = (gen2ShardCount: number) =>
  test.extend<NShardRunOpsTestContext>({
    legacyUri: async ({}, use) => {
      await withClonedDatabase(getSharedPostgres14(), "nShardLegacy", use);
    },
    newUri: async ({}, use) => {
      await withClonedDatabase(getSharedRunOpsPostgres17(), "nShardNew", use);
    },
    shardUris: async ({}, use) => {
      const shared = await getSharedRunOpsPostgres17();
      const clones: string[] = [];
      try {
        for (let i = 0; i < gen2ShardCount; i++) {
          clones.push(await cloneDatabase(shared, "nShardGen2"));
        }
        await use(
          clones.map((db) => postgresUriWithDatabase(shared.container.getConnectionUri(), db))
        );
      } finally {
        for (const db of clones) {
          await dropDatabase(shared, db);
        }
      }
    },
    legacyPrisma: async ({ legacyUri }, use) => {
      const prisma = new PrismaClient({ datasources: { db: { url: legacyUri } } });
      try {
        await use(prisma);
      } finally {
        await prisma.$disconnect();
      }
    },
    newPrisma: async ({ newUri }, use) => {
      const prisma = new RunOpsPrismaClient({ datasources: { db: { url: newUri } } });
      try {
        await use(prisma);
      } finally {
        await prisma.$disconnect();
      }
    },
    shardPrismas: async ({ shardUris }, use) => {
      const clients = shardUris.map(
        (url) => new RunOpsPrismaClient({ datasources: { db: { url } } })
      );
      try {
        await use(clients);
      } finally {
        for (const c of clients) {
          await c.$disconnect();
        }
      }
    },
  });

export const redisContainer = async (
  { network, task }: { network: StartedNetwork } & TestContext,
  use: Use<StartedRedisContainer>
) => {
  const { container, metadata: _metadata } = await withContainerSetup({
    name: "redisContainer",
    task,
    setup: createRedisContainer({
      port: 6379,
      network,
    }),
  });

  await useContainer("redisContainer", { container, task, use: () => use(container) });
};

export const redisOptions = async (
  { redisContainer }: { redisContainer: StartedRedisContainer },
  use: Use<RedisOptions>
) => {
  const options: RedisOptions = {
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
    password: redisContainer.getPassword(),
    maxRetriesPerRequest: 20, // Lower the retry attempts
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    connectTimeout: 10000, // 10 seconds
    // Add more robust connection options
    enableOfflineQueue: true,
    reconnectOnError: (err) => {
      const targetError = "READONLY";
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
    enableAutoPipelining: true,
    autoResubscribe: true,
    autoResendUnfulfilledCommands: true,
    lazyConnect: false,
    showFriendlyErrorStack: true,
  };

  console.log("Redis options", options);

  await use(options);
};

// Worker-scoped redis: booted once per worker, FLUSHALL per test. Big win for redis-heavy files
// (buffer.test.ts: 88 boots -> 1). Safe ONLY for tests that don't leave background redis work
// (a Worker loop, BatchQueue) running past the test body - use isolatedRedisTest for those.
const bootWorkerRedis = async ({}, use: Use<StartedRedisContainer>) => {
  const { container } = await createRedisContainer({ port: 6379 });
  try {
    await use(container);
  } finally {
    await container.stop({ timeout: 0 });
  }
};

const flushRedis = async (
  { redisContainer }: { redisContainer: StartedRedisContainer },
  use: Use<void>
) => {
  const redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
    password: redisContainer.getPassword(),
    maxRetriesPerRequest: 3,
  });
  try {
    await redis.flushall();
  } finally {
    redis.disconnect();
  }
  await use();
};

type HeteroRunOpsWithRedisContext = HeteroRunOpsPostgresTestContext & {
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
};

// heteroRunOpsPostgresTest (PG14 + PG17, dedicated-schema run-ops) composed with the WORKER-SCOPED
// Redis container — boots once per worker, FLUSHALL between tests, matching containerTest. Not
// postgresAndRedisTest, which boots a container per test and times out under load.
export const heteroRunOpsWithRedisTest = test.extend<HeteroRunOpsWithRedisContext>({
  ...heteroRunOpsFixtures,
  redisContainer: [bootWorkerRedis, { scope: "worker" }],
  resetRedis: [flushRedis, { auto: true }],
  redisOptions,
});

type RedisTestContext = {
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
};

// Worker-scoped redis (boots once, FLUSHALL between tests). Use isolatedRedisTest for tests that run
// background redis work (redis-worker Workers, BatchQueue) past the test body - see its note + README.
export const redisTest = withWarmup(
  test.extend<RedisTestContext>({
    redisContainer: [bootWorkerRedis, { scope: "worker" }],
    resetRedis: [flushRedis, { auto: true }],
    redisOptions,
  }),
  async ({ redisContainer }) => {
    void redisContainer;
  }
);

// Per-test redis for tests with background redis work (redis-worker Workers, BatchQueue) that can
// outlive the test body - a shared redis would let leaked work hit a closed connection / next test
// ("Connection is closed"). Boot is kept fast (see createRedisContainer).
export const isolatedRedisTest = test.extend<RedisContext>({
  network,
  redisContainer,
  redisOptions,
});

const electricOrigin = async (
  {
    postgresContainer,
    network,
    task,
  }: { postgresContainer: StartedPostgreSqlContainer; network: StartedNetwork } & TestContext,
  use: Use<string>
) => {
  const {
    origin,
    container,
    metadata: _metadata,
  } = await withContainerSetup({
    name: "electricContainer",
    task,
    setup: createElectricContainer(postgresContainer, network),
  });

  await useContainer("electricContainer", { container, task, use: () => use(origin) });
};

const clickhouseContainer = async (
  { network, task }: { network: StartedNetwork } & TestContext,
  use: Use<StartedClickHouseContainer>
) => {
  const { container, metadata: _metadata } = await withContainerSetup({
    name: "clickhouseContainer",
    task,
    setup: createClickHouseContainer(network),
  });

  await useContainer("clickhouseContainer", { container, task, use: () => use(container) });
};

const clickhouseClient = async (
  { clickhouseContainer, task }: { clickhouseContainer: StartedClickHouseContainer } & TestContext,
  use: Use<ClickHouseClient>
) => {
  const testName = task.name;
  const client = createClient({ url: clickhouseContainer.getConnectionUrl() });

  try {
    await use(client);
  } finally {
    await logCleanup("clickhouseClient", client.close(), { testName });
  }
};

type ClickhouseContext = {
  network: StartedNetwork;
  clickhouseContainer: StartedClickHouseContainer;
  clickhouseClient: ClickHouseClient;
};

const clickhouseMigrationsPath = path.resolve(__dirname, "../../clickhouse/schema");

type ClickhouseTestContext = {
  clickhouseContainer: StartedClickHouseContainer;
  resetClickhouse: void;
  clickhouseClient: ClickHouseClient;
};

// Boot + migrate clickhouse once per worker.
const bootWorkerClickhouse = async ({}, use: Use<StartedClickHouseContainer>) => {
  const container = await withCiResourceLimits(new ClickHouseContainer()).start();
  const client = createClient({ url: container.getConnectionUrl() });
  await client.ping();
  await runClickhouseMigrations(client, clickhouseMigrationsPath);
  await client.close();
  try {
    await use(container);
  } finally {
    await container.stop({ timeout: 0 });
  }
};

// Per test: truncate all tables on the shared clickhouse (auto fixture so it runs for every test).
const truncateClickhouseFixture = async (
  { clickhouseContainer }: { clickhouseContainer: StartedClickHouseContainer },
  use: Use<void>
) => {
  const client = createClient({ url: clickhouseContainer.getConnectionUrl() });
  await truncateClickhouseTables(client);
  await client.close();
  await use();
};

const scopedClickhouseClient = async (
  { clickhouseContainer }: { clickhouseContainer: StartedClickHouseContainer },
  use: Use<ClickHouseClient>
) => {
  const client = createClient({ url: clickhouseContainer.getConnectionUrl() });
  try {
    await use(client);
  } finally {
    await logCleanup("clickhouseClient", client.close());
  }
};

export const clickhouseTest = withWarmup(
  test.extend<ClickhouseTestContext>({
    clickhouseContainer: [bootWorkerClickhouse, { scope: "worker" }],
    resetClickhouse: [truncateClickhouseFixture, { auto: true }],
    clickhouseClient: scopedClickhouseClient,
  }),
  async ({ clickhouseContainer }) => {
    void clickhouseContainer;
  }
);

/**
 * A cloned database per test on a Postgres private to this file (logical replication slots are
 * cluster-wide and tests name them), plus a per-test Redis.
 */
export const postgresAndRedisTest = test.extend<PostgresAndRedisContext>({
  network,
  postgresContainer: clonedContainerFrom(getPrivatePostgres14),
  prisma,
  redisContainer,
  redisOptions,
});

type ContainerTestContext = {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  schemaOnlyPrisma: PrismaClient;
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
};

/**
 * The workhorse fixture: template-cloned Postgres and FLUSHALL'd Redis, both booted once per worker.
 * Use containerTestWithIsolatedRedis when background redis work outlives the test body, and
 * clickhouseTest for ClickHouse.
 */
export const containerTest = withWarmup(
  test.extend<ContainerTestContext>({
    postgresContainer: clonedPostgresContainer,
    prisma: prismaFromContainer,
    schemaOnlyPrisma: schemaOnlyPrismaFixture,
    redisContainer: [bootWorkerRedis, { scope: "worker" }],
    resetRedis: [flushRedis, { auto: true }],
    redisOptions,
  }),
  async ({ redisContainer }) => {
    void redisContainer;
    await getSharedPostgres14();
  }
);

type ContainerWithClickhouseTestContext = ContainerTestContext & {
  clickhouseContainer: StartedClickHouseContainer;
  resetClickhouse: void;
  clickhouseClient: ClickHouseClient;
};

/** containerTest plus a worker-scoped ClickHouse, truncated before each test. */
export const containerTestWithClickhouse = withWarmup(
  test.extend<ContainerWithClickhouseTestContext>({
    postgresContainer: clonedPostgresContainer,
    prisma: prismaFromContainer,
    schemaOnlyPrisma: schemaOnlyPrismaFixture,
    redisContainer: [bootWorkerRedis, { scope: "worker" }],
    resetRedis: [flushRedis, { auto: true }],
    redisOptions,
    clickhouseContainer: [bootWorkerClickhouse, { scope: "worker" }],
    resetClickhouse: [truncateClickhouseFixture, { auto: true }],
    clickhouseClient: scopedClickhouseClient,
  }),
  async ({ redisContainer, clickhouseContainer }) => {
    void redisContainer;
    void clickhouseContainer;
    await getSharedPostgres14();
  }
);

export type ContainerBlipTestContext = PostgresBlipTestContext & {
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
};

// postgresBlipTest (adapter-backed postgres + a DbBlipController) composed with a worker-scoped
// Redis, so a blip test can drive a full RunEngine through its real surfaces (trigger, waitpoint
// completion, continue) while severing the database connection mid-operation.
export const containerBlipTest = withWarmup(
  test.extend<ContainerBlipTestContext>({
    postgresContainer: clonedPostgresContainer,
    prisma: blipPrismaFromContainer,
    blip: blipFromContainer,
    redisContainer: [bootWorkerRedis, { scope: "worker" }],
    resetRedis: [flushRedis, { auto: true }],
    redisOptions,
  }),
  async ({ redisContainer }) => {
    void redisContainer;
    await getSharedPostgres14();
  }
);

type ContainerWithIsolatedRedisContext = {
  network: StartedNetwork;
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
};

// Same as containerTest but Redis is PER-TEST - for tests whose background redis work (BatchQueue,
// Workers) outlives the test body and would otherwise hit a closed/shared connection.
export const containerTestWithIsolatedRedis = withWarmup(
  test.extend<ContainerWithIsolatedRedisContext>({
    network,
    postgresContainer: clonedPostgresContainer,
    prisma: prismaFromContainer,
    redisContainer,
    redisOptions,
  }),
  async () => {
    await getSharedPostgres14();
  }
);

type ReplicationContainerTestContext = {
  network: StartedNetwork;
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
  clickhouseContainer: StartedClickHouseContainer;
  resetClickhouse: void;
  clickhouseClient: ClickHouseClient;
};

export const replicationContainerTest = test.extend<ReplicationContainerTestContext>({
  network,
  postgresContainer: clonedContainerFrom(getPrivatePostgres14),
  prisma,
  redisContainer,
  redisOptions,
  clickhouseContainer: [bootWorkerClickhouse, { scope: "worker" }],
  resetClickhouse: [truncateClickhouseFixture, { auto: true }],
  clickhouseClient: scopedClickhouseClient,
});

export const containerWithElectricTest = test.extend<ContainerWithElectricContext>({
  network,
  postgresContainer,
  prisma,
  electricOrigin,
});

export const containerWithElectricAndRedisTest = test.extend<ContainerWithElectricAndRedisContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
  electricOrigin,
  clickhouseContainer,
  clickhouseClient,
});

// Boot minio once per worker; reset the bucket per test (auto fixture).
const bootWorkerMinio = async ({}, use: Use<StartedMinIOContainer>) => {
  const container = await withCiResourceLimits(new MinIOContainer()).start();
  try {
    await use(container);
  } finally {
    await container.stop({ timeout: 0 });
  }
};

const minioReset = async (
  { minioContainer }: { minioContainer: StartedMinIOContainer },
  use: Use<void>
) => {
  await minioContainer.resetBucket();
  await use();
};

const minioConfig = async (
  { minioContainer }: { minioContainer: StartedMinIOContainer },
  use: Use<MinIOConnectionConfig>
) => {
  await use(minioContainer.getConnectionConfig());
};

type MinioTestContext = {
  minioContainer: StartedMinIOContainer;
  resetMinio: void;
  minioConfig: MinIOConnectionConfig;
};

export const minioTest = withWarmup(
  test.extend<MinioTestContext>({
    minioContainer: [bootWorkerMinio, { scope: "worker" }],
    resetMinio: [minioReset, { auto: true }],
    minioConfig,
  }),
  async ({ minioContainer }) => {
    void minioContainer;
  }
);

type PostgresAndMinioTestContext = {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  minioContainer: StartedMinIOContainer;
  resetMinio: void;
  minioConfig: MinIOConnectionConfig;
};

export const postgresAndMinioTest = withWarmup(
  test.extend<PostgresAndMinioTestContext>({
    postgresContainer: clonedPostgresContainer,
    prisma: prismaFromContainer,
    minioContainer: [bootWorkerMinio, { scope: "worker" }],
    resetMinio: [minioReset, { auto: true }],
    minioConfig,
  }),
  async ({ minioContainer }) => {
    void minioContainer;
    await getSharedPostgres14();
  }
);

export { slotOf, expectOneSlot } from "./clusterSlot";
export { createFaultInjector, type FaultInjector } from "./faultInjection";
