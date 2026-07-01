import { type ClickHouseClient,createClient } from "@clickhouse/client";
import { type StartedPostgreSqlContainer,PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import Redis,{ type RedisOptions } from "ioredis";
import path from "path";
import { type StartedNetwork,Network } from "testcontainers";
import { type TestContext,test } from "vitest";
import { type StartedClickHouseContainer,ClickHouseContainer,runClickhouseMigrations,truncateClickhouseTables } from "./clickhouse";
import { getTaskMetadata,logCleanup,logSetup } from "./logs";
import { type MinIOConnectionConfig,type StartedMinIOContainer,MinIOContainer } from "./minio";
import {
createClickHouseContainer,
createElectricContainer,
createPostgresContainer,
createRedisContainer,
postgresUriWithDatabase,
pushDatabaseSchema,
useContainer,
withCiResourceLimits,
withContainerSetup,
} from "./utils";

export { assertNonNullable,createPostgresContainer } from "./utils";
export { logCleanup };
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
StartedMinIOContainer,StartedNetwork,
StartedPostgreSqlContainer,
StartedRedisContainer
};

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
    // Make sure to stop the network after use
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

const POSTGRES_TEMPLATE_DB = "template_db";
let pgCloneCounter = 0;

type PostgresTestContext = {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
};

// --- Worker-scoped + per-test-isolated fixtures (shared by the standalone *Test and containerTest) ---
// The pattern: boot each container ONCE per worker; isolate per test cheaply (postgres = template
// clone, redis = FLUSHALL, clickhouse = TRUNCATE) instead of re-booting. Reset fixtures are `auto`
// so they run for every test even if it doesn't destructure them.

// Boot postgres ONCE per worker (module singleton, reaped by Ryuk on worker exit) and push the
// schema into a dedicated template db that nothing else connects to (so CREATE DATABASE ... TEMPLATE
// never trips on an active session).
let workerPostgresContainer: Promise<StartedPostgreSqlContainer> | undefined;
const getWorkerPostgresContainer = () => {
  if (!workerPostgresContainer) {
    workerPostgresContainer = (async () => {
      const container = await withCiResourceLimits(new PostgreSqlContainer("docker.io/postgres:14"))
        .withCommand(["-c", "listen_addresses=*", "-c", "wal_level=logical"])
        .start();
      // Create the template db explicitly via an admin connection (the same primitive the per-test
      // clone uses) instead of relying on `prisma db push` to create a missing database. That
      // create-if-missing path behaves differently on CI and - because push errors were swallowed -
      // surfaced only later as a confusing "template database template_db does not exist" at clone
      // time. Pushing into an already-existing db is the path the pre-worker-scope code always used.
      const admin = new PrismaClient({
        datasources: {
          db: { url: postgresUriWithDatabase(container.getConnectionUri(), "postgres") },
        },
      });
      await admin.$executeRawUnsafe(`CREATE DATABASE "${POSTGRES_TEMPLATE_DB}"`);
      await admin.$disconnect();
      await pushDatabaseSchema(
        postgresUriWithDatabase(container.getConnectionUri(), POSTGRES_TEMPLATE_DB)
      );
      return container;
    })();
  }
  return workerPostgresContainer;
};

// Per test: clone a fresh database from the template (fast filesystem copy), then hand back a view
// of the shared container whose connection points at the clone. This keeps prisma AND any code that
// reads postgresContainer.getConnectionUri()/getDatabase() (e.g. logical replication) on the SAME
// isolated database - and it's parallel-ready (each test owns its db).
const clonedPostgresContainer = async ({}, use: Use<StartedPostgreSqlContainer>) => {
  const container = await getWorkerPostgresContainer();
  const baseUri = container.getConnectionUri();
  const cloneDb = `test_${pgCloneCounter++}`;

  await createDatabaseFromTemplate(baseUri, cloneDb);

  const cloneUri = postgresUriWithDatabase(baseUri, cloneDb);
  const view = new Proxy(container, {
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
    await dropCloneDatabase(baseUri, cloneDb);
  }
};

const createDatabaseFromTemplate = async (baseUri: string, cloneDb: string) => {
  const admin = new PrismaClient({
    datasources: { db: { url: postgresUriWithDatabase(baseUri, "postgres") } },
  });
  try {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${cloneDb}" TEMPLATE "${POSTGRES_TEMPLATE_DB}"`
    );
  } finally {
    await admin.$disconnect();
  }
};

// Best-effort drop so clones don't pile up in the worker's pg over a long suite. WITH (FORCE)
// terminates any lingering backends (pg 13+). A failed drop is harmless - the whole container is
// reaped on worker exit - so we never let cleanup fail the test.
const dropCloneDatabase = async (baseUri: string, cloneDb: string) => {
  const cleanup = new PrismaClient({
    datasources: { db: { url: postgresUriWithDatabase(baseUri, "postgres") } },
  });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${cloneDb}" WITH (FORCE)`);
  } catch {
    // ignore - reaped with the container anyway
  } finally {
    await cleanup.$disconnect();
  }
};

// A second migrated-but-empty database on the same worker postgres, cloned from the schema
// template. For tests that need to simulate a read replica that hasn't caught up: schema
// present, rows absent. Lazy - only booted when a test destructures it.
const schemaOnlyPrismaFixture = async ({}: {}, use: Use<PrismaClient>) => {
  const container = await getWorkerPostgresContainer();
  const baseUri = container.getConnectionUri();
  const cloneDb = `schema_only_${pgCloneCounter++}`;

  await createDatabaseFromTemplate(baseUri, cloneDb);

  const prisma = new PrismaClient({
    datasources: { db: { url: postgresUriWithDatabase(baseUri, cloneDb) } },
  });
  try {
    await use(prisma);
  } finally {
    await logCleanup("schemaOnlyPrisma", prisma.$disconnect());
    await dropCloneDatabase(baseUri, cloneDb);
  }
};

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

export const postgresTest = test.extend<PostgresTestContext>({
  postgresContainer: clonedPostgresContainer,
  prisma: prismaFromContainer,
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

type RedisTestContext = {
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
};

// Worker-scoped redis (boots once, FLUSHALL between tests). Use isolatedRedisTest for tests that run
// background redis work (redis-worker Workers, BatchQueue) past the test body - see its note + README.
export const redisTest = test.extend<RedisTestContext>({
  redisContainer: [bootWorkerRedis, { scope: "worker" }],
  resetRedis: [flushRedis, { auto: true }],
  redisOptions,
});

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
  const { origin, container, metadata: _metadata } = await withContainerSetup({
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

export const clickhouseTest = test.extend<ClickhouseTestContext>({
  clickhouseContainer: [bootWorkerClickhouse, { scope: "worker" }],
  resetClickhouse: [truncateClickhouseFixture, { auto: true }],
  clickhouseClient: scopedClickhouseClient,
});

// NOTE: per-test containers (not worker-scoped) - the replication package does logical replication
// (slots/publications/REPLICA IDENTITY), which doesn't play nicely with a shared container +
// template-clone. A dedicated container per test is the correct, isolated choice here.
export const postgresAndRedisTest = test.extend<PostgresAndRedisContext>({
  network,
  postgresContainer,
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
  clickhouseContainer: StartedClickHouseContainer;
  resetClickhouse: void;
  clickhouseClient: ClickHouseClient;
};

// The workhorse fixture (~36 files). Postgres (template-clone), Redis (FLUSHALL) and ClickHouse
// (truncate) all boot once per worker - no per-test container boots. Use containerTestWithIsolatedRedis
// for tests that run background redis work (BatchQueue, redis-worker Workers) past the test body.
export const containerTest = test.extend<ContainerTestContext>({
  postgresContainer: clonedPostgresContainer,
  prisma: prismaFromContainer,
  schemaOnlyPrisma: schemaOnlyPrismaFixture,
  redisContainer: [bootWorkerRedis, { scope: "worker" }],
  resetRedis: [flushRedis, { auto: true }],
  redisOptions,
  clickhouseContainer: [bootWorkerClickhouse, { scope: "worker" }],
  resetClickhouse: [truncateClickhouseFixture, { auto: true }],
  clickhouseClient: scopedClickhouseClient,
});

type ContainerWithIsolatedRedisContext = {
  network: StartedNetwork;
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
  clickhouseContainer: StartedClickHouseContainer;
  resetClickhouse: void;
  clickhouseClient: ClickHouseClient;
};

// Same as containerTest but Redis is PER-TEST - for tests whose background redis work (BatchQueue,
// Workers) outlives the test body and would otherwise hit a closed/shared connection.
export const containerTestWithIsolatedRedis = test.extend<ContainerWithIsolatedRedisContext>({
  network,
  postgresContainer: clonedPostgresContainer,
  prisma: prismaFromContainer,
  redisContainer,
  redisOptions,
  clickhouseContainer: [bootWorkerClickhouse, { scope: "worker" }],
  resetClickhouse: [truncateClickhouseFixture, { auto: true }],
  clickhouseClient: scopedClickhouseClient,
});

type ContainerWithIsolatedRedisNoClickhouseContext = {
  network: StartedNetwork;
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
};

// Like containerTestWithIsolatedRedis (template-clone Postgres + per-test Redis) but with no
// ClickHouse - for suites that touch Postgres + Redis but never ClickHouse, avoiding its boot+migrate.
export const containerTestWithIsolatedRedisNoClickhouse =
  test.extend<ContainerWithIsolatedRedisNoClickhouseContext>({
    network,
    postgresContainer: clonedPostgresContainer,
    prisma: prismaFromContainer,
    redisContainer,
    redisOptions,
  });

// For tests that exercise the Postgres -> ClickHouse logical-replication pipeline (WAL slots,
// publications, REPLICA IDENTITY). These need a dedicated Postgres per test - the worker-scoped +
// template-clone model used by containerTest doesn't carry logical replication across cloned dbs.
// Postgres is per-test (the WAL slot/publication lives in the db it writes to); ClickHouse is
// worker-scoped + truncated (the pipeline writes pg->clickhouse and a shared+truncated clickhouse is
// fine). Redis is per-test too (background work safety, same as containerTest).
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
  postgresContainer,
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

export const minioTest = test.extend<MinioTestContext>({
  minioContainer: [bootWorkerMinio, { scope: "worker" }],
  resetMinio: [minioReset, { auto: true }],
  minioConfig,
});

type PostgresAndMinioTestContext = {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  minioContainer: StartedMinIOContainer;
  resetMinio: void;
  minioConfig: MinIOConnectionConfig;
};

export const postgresAndMinioTest = test.extend<PostgresAndMinioTestContext>({
  postgresContainer: clonedPostgresContainer,
  prisma: prismaFromContainer,
  minioContainer: [bootWorkerMinio, { scope: "worker" }],
  resetMinio: [minioReset, { auto: true }],
  minioConfig,
});
