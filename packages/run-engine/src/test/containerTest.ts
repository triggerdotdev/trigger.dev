import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { Redis } from "ioredis";
import { test } from "vitest";
import { createPostgresContainer, createRedisContainer } from "./utils";

type ContainerTest = {
  postgresContainer: StartedPostgreSqlContainer;
  redisContainer: StartedRedisContainer;
  prisma: PrismaClient;
  redis: Redis;
};

export const containerTest = test.extend<ContainerTest>({
  postgresContainer: async ({}, use) => {
    const { container } = await createPostgresContainer();
    await use(container);
    await container.stop();
  },
  redisContainer: async ({}, use) => {
    const { container } = await createRedisContainer();
    await use(container);
    await container.stop();
  },
  prisma: async ({ postgresContainer }, use) => {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: postgresContainer.getConnectionUri(),
        },
      },
    });
    await use(prisma);
    await prisma.$disconnect();
  },
  redis: async ({ redisContainer }, use) => {
    const redis = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
      password: redisContainer.getPassword(),
    });
    await use(redis);
    await redis.quit();
  },
});
