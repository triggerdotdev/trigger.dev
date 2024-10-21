import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { test } from "vitest";
import { PrismaClient } from "@trigger.dev/database";
import { createPostgresContainer, createRedisContainer, createElectricContainer } from "./utils";
import { Network, type StartedNetwork, type StartedTestContainer } from "testcontainers";

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
type ContainerWithElectricContext = ContainerContext & ElectricContext;

type Use<T> = (value: T) => Promise<void>;

const network = async ({}, use: Use<StartedNetwork>) => {
  const network = await new Network().start();
  await use(network);
};

const postgresContainer = async (
  { network }: { network: StartedNetwork },
  use: Use<StartedPostgreSqlContainer>
) => {
  const { container } = await createPostgresContainer(network);
  await use(container);
  await container.stop();
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
  await use(prisma);
  await prisma.$disconnect();
};

export const postgresTest = test.extend<PostgresContext>({ network, postgresContainer, prisma });

const redisContainer = async ({}, use: Use<StartedRedisContainer>) => {
  const { container } = await createRedisContainer();
  await use(container);
  await container.stop();
};

const redis = async (
  { redisContainer }: { redisContainer: StartedRedisContainer },
  use: Use<Redis>
) => {
  const redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
    password: redisContainer.getPassword(),
  });
  await use(redis);
  await redis.quit();
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
  await use(origin);
  await container.stop();
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
  redisContainer,
  redis,
  electricOrigin,
});
