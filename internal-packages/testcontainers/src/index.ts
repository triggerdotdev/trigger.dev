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

let cleanupOrder = 0;
let activeCleanups = 0;

/**
 * Logs the cleanup of a resource.
 * @param resource - The resource that is being cleaned up.
 * @param promise - The cleanup promise to await..
 */
async function logCleanup(resource: string, promise: Promise<unknown>) {
  const start = new Date();
  const order = cleanupOrder++;
  const activeAtStart = ++activeCleanups;

  let error: unknown = null;
  try {
    await promise;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const end = new Date();
  const activeAtEnd = --activeCleanups;
  const parallel = activeAtStart > 1 || activeAtEnd > 0;

  console.log(
    JSON.stringify({
      order,
      resource,
      durationMs: end.getTime() - start.getTime(),
      start: start.toISOString(),
      end: end.toISOString(),
      parallel,
      error,
      activeAtStart,
      activeAtEnd,
    })
  );
}

const network = async ({}, use: Use<StartedNetwork>) => {
  const network = await new Network().start();
  try {
    await use(network);
  } finally {
    // Make sure to stop the network after use
    await logCleanup("network", network.stop());
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
    await logCleanup("postgresContainer", container.stop({ timeout: 30 }));
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
    await logCleanup("prisma", prisma.$disconnect());
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
    await logCleanup("redisContainer", container.stop({ timeout: 30 }));
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
    await logCleanup("electricContainer", container.stop({ timeout: 30 }));
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
