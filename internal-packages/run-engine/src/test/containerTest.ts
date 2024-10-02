import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import { test } from "vitest";
import { PrismaClient } from "../../../database/src";
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

export const postgresTest = test.extend<PostgresContext>({ postgresContainer, prisma });

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

export const containerTest = test.extend<ContainerContext>({
  postgresContainer,
  prisma,
  redisContainer,
  redis,
});

export function createContainerWithSetup(setup: (prisma: PrismaClient) => Promise<void>) {
  return containerTest.extend<{}>({
    prisma: async ({ prisma }: ContainerContext, use: (prisma: PrismaClient) => Promise<void>) => {
      await setup(prisma);
      await use(prisma);
    },
  });
}

async function setupTestDatabase(prisma: PrismaClient): Promise<void> {
  // Your database setup logic here
  const org = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: org.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: org.id,
      apiKey: "api_key",
      pkApiKey: "pk_api_key",
      shortcode: "short_code",
    },
  });
}

export const containerTestWithAuthenticatedEnvironment =
  createContainerWithSetup(setupTestDatabase);
