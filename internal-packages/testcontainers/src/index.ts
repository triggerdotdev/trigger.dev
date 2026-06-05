import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import Redis, { RedisOptions } from "ioredis";
import { Network, type StartedNetwork } from "testcontainers";
import { TestContext, test } from "vitest";
import {
  createClickHouseContainer,
  createElectricContainer,
  createPostgresContainer,
  createRedisContainer,
  createMinIOContainer,
  postgresUriWithDatabase,
  pushDatabaseSchema,
  useContainer,
  withContainerSetup,
} from "./utils";
import { getTaskMetadata, logCleanup, logSetup } from "./logs";
import path from "path";
import {
  ClickHouseContainer,
  StartedClickHouseContainer,
  runClickhouseMigrations,
  truncateClickhouseTables,
} from "./clickhouse";
import { StartedMinIOContainer, type MinIOConnectionConfig } from "./minio";
import { ClickHouseClient, createClient } from "@clickhouse/client";

export { assertNonNullable, createPostgresContainer } from "./utils";
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

type MinIOContext = NetworkContext & {
  minioContainer: StartedMinIOContainer;
  minioConfig: MinIOConnectionConfig;
};

export type {
  StartedNetwork,
  StartedPostgreSqlContainer,
  StartedRedisContainer,
  StartedClickHouseContainer,
  StartedMinIOContainer,
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
  const { container, metadata } = await withContainerSetup({
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

// Boot postgres once + push the schema into a dedicated template db that nothing else connects to
// (so CREATE DATABASE ... TEMPLATE never trips on an active session).
const bootWorkerPostgres = async ({}, use: Use<StartedPostgreSqlContainer>) => {
  const container = await new PostgreSqlContainer("docker.io/postgres:14")
    .withCommand(["-c", "listen_addresses=*", "-c", "wal_level=logical"])
    .start();
  await pushDatabaseSchema(postgresUriWithDatabase(container.getConnectionUri(), POSTGRES_TEMPLATE_DB));
  try {
    await use(container);
  } finally {
    await container.stop({ timeout: 0 });
  }
};

// Per test: clone a fresh database from the template (fast filesystem copy) - isolated AND parallel-ready.
const templateClonePrisma = async (
  { postgresContainer }: { postgresContainer: StartedPostgreSqlContainer },
  use: Use<PrismaClient>
) => {
  const baseUri = postgresContainer.getConnectionUri();
  const cloneDb = `test_${pgCloneCounter++}`;

  const admin = new PrismaClient({
    datasources: { db: { url: postgresUriWithDatabase(baseUri, "postgres") } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${cloneDb}" TEMPLATE "${POSTGRES_TEMPLATE_DB}"`);
  await admin.$disconnect();

  const prisma = new PrismaClient({
    datasources: { db: { url: postgresUriWithDatabase(baseUri, cloneDb) } },
  });
  try {
    await use(prisma);
  } finally {
    await logCleanup("prisma", prisma.$disconnect());
  }
};

export const postgresTest = test.extend<PostgresTestContext>({
  postgresContainer: [bootWorkerPostgres, { scope: "worker" }],
  prisma: templateClonePrisma,
});

export const redisContainer = async (
  { network, task }: { network: StartedNetwork } & TestContext,
  use: Use<StartedRedisContainer>
) => {
  const { container, metadata } = await withContainerSetup({
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

type RedisTestContext = {
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
};

// Boot redis once per worker.
const bootWorkerRedis = async ({}, use: Use<StartedRedisContainer>) => {
  const { container } = await createRedisContainer({ port: 6379 });
  try {
    await use(container);
  } finally {
    await container.stop({ timeout: 0 });
  }
};

// Per test: FLUSHALL the shared redis (auto fixture so it runs for every test).
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

export const redisTest = test.extend<RedisTestContext>({
  redisContainer: [bootWorkerRedis, { scope: "worker" }],
  resetRedis: [flushRedis, { auto: true }],
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
  const { origin, container, metadata } = await withContainerSetup({
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
  const { container, metadata } = await withContainerSetup({
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
  const container = await new ClickHouseContainer().start();
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
  redisContainer: StartedRedisContainer;
  resetRedis: void;
  redisOptions: RedisOptions;
  clickhouseContainer: StartedClickHouseContainer;
  resetClickhouse: void;
  clickhouseClient: ClickHouseClient;
};

// The workhorse fixture (~36 files). Boots postgres+redis+clickhouse ONCE per worker and isolates
// per test (postgres template-clone, redis FLUSHALL, clickhouse TRUNCATE) - no per-test boots, no
// shared docker network needed.
export const containerTest = test.extend<ContainerTestContext>({
  postgresContainer: [bootWorkerPostgres, { scope: "worker" }],
  prisma: templateClonePrisma,
  redisContainer: [bootWorkerRedis, { scope: "worker" }],
  resetRedis: [flushRedis, { auto: true }],
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

const minioContainer = async (
  { network, task }: { network: StartedNetwork } & TestContext,
  use: Use<StartedMinIOContainer>
) => {
  const { container, metadata } = await withContainerSetup({
    name: "minioContainer",
    task,
    setup: createMinIOContainer(network),
  });

  await useContainer("minioContainer", { container, task, use: () => use(container) });
};

const minioConfig = async (
  { minioContainer }: { minioContainer: StartedMinIOContainer },
  use: Use<MinIOConnectionConfig>
) => {
  await use(minioContainer.getConnectionConfig());
};

export const minioTest = test.extend<MinIOContext>({
  network,
  minioContainer,
  minioConfig,
});

type PostgresAndMinIOContext = NetworkContext & PostgresContext & MinIOContext;

export const postgresAndMinioTest = test.extend<PostgresAndMinIOContext>({
  network,
  postgresContainer,
  prisma,
  minioContainer,
  minioConfig,
});
