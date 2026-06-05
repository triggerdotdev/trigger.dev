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

// Standalone Postgres tests boot the container ONCE per worker and push the schema into a template
// database once. Each test then gets its OWN database cloned from that template (CREATE DATABASE ...
// TEMPLATE - a fast filesystem copy), so isolation is per-test AND parallel-friendly (no shared db,
// no reset needed). containerTest keeps its own per-test Postgres (shares a network with electric).
export const postgresTest = test.extend<PostgresTestContext>({
  postgresContainer: [
    async ({}, use: (value: StartedPostgreSqlContainer) => Promise<void>) => {
      const container = await new PostgreSqlContainer("docker.io/postgres:14")
        .withCommand(["-c", "listen_addresses=*", "-c", "wal_level=logical"])
        .start();
      // Push the schema once into a dedicated template db that nothing else connects to (so
      // CREATE DATABASE ... TEMPLATE never trips on an active session).
      await pushDatabaseSchema(postgresUriWithDatabase(container.getConnectionUri(), POSTGRES_TEMPLATE_DB));
      try {
        await use(container);
      } finally {
        await container.stop({ timeout: 0 });
      }
    },
    { scope: "worker" },
  ],
  prisma: async ({ postgresContainer }, use) => {
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
  },
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

// Standalone Redis tests boot the container ONCE per worker (reused across files) and isolate per
// test by FLUSHALL in an `auto` fixture (runs for every test even if it only takes redisOptions).
// containerTest keeps its own per-test Redis (shares a docker network with postgres/clickhouse).
export const redisTest = test.extend<RedisTestContext>({
  redisContainer: [
    async ({}, use: (value: StartedRedisContainer) => Promise<void>) => {
      const { container } = await createRedisContainer({ port: 6379 });
      try {
        await use(container);
      } finally {
        await container.stop({ timeout: 0 });
      }
    },
    { scope: "worker" },
  ],
  // auto: runs for every test regardless of whether it destructures this fixture
  resetRedis: [
    async ({ redisContainer }, use) => {
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
    },
    { auto: true },
  ],
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

// Standalone ClickHouse tests boot + migrate the container ONCE per worker (reused across files),
// and isolate per test by truncating tables (an `auto` fixture, so it runs for EVERY test even if
// the test only destructures clickhouseContainer). containerTest keeps its own per-test ClickHouse
// (it shares a docker network with postgres/redis), so this scoping is narrow.
export const clickhouseTest = test.extend<ClickhouseTestContext>({
  clickhouseContainer: [
    async ({}, use: Use<StartedClickHouseContainer>) => {
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
    },
    { scope: "worker" },
  ],
  // auto: runs for every test regardless of whether it destructures this fixture
  resetClickhouse: [
    async ({ clickhouseContainer }, use) => {
      const client = createClient({ url: clickhouseContainer.getConnectionUrl() });
      await truncateClickhouseTables(client);
      await client.close();
      await use();
    },
    { auto: true },
  ],
  clickhouseClient: async ({ clickhouseContainer }, use) => {
    const client = createClient({ url: clickhouseContainer.getConnectionUrl() });
    try {
      await use(client);
    } finally {
      await logCleanup("clickhouseClient", client.close());
    }
  },
});

export const postgresAndRedisTest = test.extend<PostgresAndRedisContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
});

export const containerTest = test.extend<ContainerContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
  clickhouseContainer,
  clickhouseClient,
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
