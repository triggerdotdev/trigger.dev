import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { RedisOptions } from "ioredis";
import { Network, type StartedNetwork } from "testcontainers";
import { test } from "vitest";
import { createElectricContainer, createPostgresContainer, createRedisContainer } from "./utils";

export { assertNonNullable } from "./utils";
export { StartedRedisContainer };

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

type ContainerContext = NetworkContext & PostgresContext & RedisContext;
type ContainerWithElectricAndRedisContext = ContainerContext & ElectricContext;
type ContainerWithElectricContext = NetworkContext & PostgresContext & ElectricContext;

type Use<T> = (value: T) => Promise<void>;

const network = async ({}, use: Use<StartedNetwork>) => {
  const network = await new Network().start();
  try {
    await use(network);
  } finally {
    try {
      await network.stop();
    } catch (error) {
      console.warn("Network stop error (ignored):", error);
    }
    // Make sure to stop the network after use
  }
};

const postgresContainer = async (
  { network }: { network: StartedNetwork },
  use: Use<StartedPostgreSqlContainer>
) => {
  const { container } = await createPostgresContainer(network);
  try {
    await use(container);
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second
    await container.stop({ timeout: 10 });
  }
};

const prisma = async (
  { postgresContainer }: { postgresContainer: StartedPostgreSqlContainer },
  use: Use<PrismaClient>
) => {
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
    await prisma.$disconnect();
  }
};

export const postgresTest = test.extend<PostgresContext>({ network, postgresContainer, prisma });

const redisContainer = async (
  { network }: { network: StartedNetwork },
  use: Use<StartedRedisContainer>
) => {
  const { container } = await createRedisContainer({
    port: 6379,
    network,
  });
  try {
    await use(container);
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second
    await container.stop({ timeout: 10 });
  }
};

const redisOptions = async (
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

  await use(options);
};

export const redisTest = test.extend<RedisContext>({ network, redisContainer, redisOptions });

const electricOrigin = async (
  {
    postgresContainer,
    network,
  }: { postgresContainer: StartedPostgreSqlContainer; network: StartedNetwork },
  use: Use<string>
) => {
  const { origin, container } = await createElectricContainer(postgresContainer, network);
  try {
    await use(origin);
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second

    await container.stop({ timeout: 10 });
  }
};

export const containerTest = test.extend<ContainerContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
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
});
