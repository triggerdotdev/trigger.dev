import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { Redis } from "ioredis";
import { test, TestAPI } from "vitest";
import { createPostgresContainer, createRedisContainer } from "./utils";

type PostgresContext = {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
};

type RedisContext = { redisContainer: StartedRedisContainer; redis: Redis };
type ContainerContext = PostgresContext & RedisContext;

type Use<T> = (value: T) => Promise<void>;

const postgresContainer = async ({}, use: Use<StartedPostgreSqlContainer>) => {
  const { container } = await createPostgresContainer();
  await use(container);
  await container.stop();
};

const redisContainer = async ({}, use: Use<StartedRedisContainer>) => {
  const { container } = await createRedisContainer();
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

export const containerTest = test.extend<ContainerContext>({
  postgresContainer,
  prisma,
  redisContainer,
  redis,
});

export const postgresTest = test.extend<PostgresContext>({ postgresContainer, prisma });

export const redisTest = test.extend<RedisContext>({ redisContainer, redis });
