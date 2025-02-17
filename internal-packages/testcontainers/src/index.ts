import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { Redis } from "ioredis";
import { Network, type StartedNetwork } from "testcontainers";
import { test } from "vitest";
import { createElectricContainer, createPostgresContainer, createRedisContainer } from "./utils";

export { StartedRedisContainer };
export * from "./setup";
export { assertNonNullable } from "./utils";

type NetworkContext = { network: StartedNetwork };

type PostgresContext = NetworkContext & {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
};

type RedisContext = { redisContainer: StartedRedisContainer; redis: Redis };

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
    // Make sure to stop the network after use
    await network.stop();
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
    await container.stop();
  }
};

const prisma = async (
  { postgresContainer }: { postgresContainer: StartedPostgreSqlContainer },
  use: Use<PrismaClient>
) => {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: postgresContainer.getConnectionUri(),
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

let redisPortCounter = 6379;

const getUniqueRedisPort = () => {
  return redisPortCounter++;
};

const redisContainer = async ({}, use: Use<StartedRedisContainer>) => {
  const uniquePort = getUniqueRedisPort();
  const { container } = await createRedisContainer({
    port: uniquePort,
  });
  try {
    await use(container);
  } finally {
    await container.stop();
  }
};

const redis = async (
  { redisContainer }: { redisContainer: StartedRedisContainer },
  use: Use<Redis>
) => {
  const redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
    password: redisContainer.getPassword(),
    maxRetriesPerRequest: 3, // Lower the retry attempts
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    connectTimeout: 10000, // 10 seconds
    // Add more robust connection options
    enableOfflineQueue: false,
    reconnectOnError: (err) => {
      const targetError = "READONLY";
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
  });

  // Add connection error handling
  redis.on("error", (error) => {
    console.error("Redis connection error:", error);
  });

  // Wait for ready state
  await new Promise((resolve) => redis.once("ready", resolve));

  try {
    await use(redis);
  } finally {
    await redis.quit();
  }
};

export const redisTest = test.extend<RedisContext>({ redisContainer, redis });

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
    await container.stop();
  }
};

export const containerTest = test.extend<ContainerContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redis,
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
  redis,
  electricOrigin,
});
