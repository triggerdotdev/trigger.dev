import { PrismaClient, Prisma } from "@trigger.dev/database";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import path from "path";
import { execSync } from "child_process";
import Redis, { RedisOptions } from "ioredis";

export async function createTestPrismaClient() {
  const container = await new PostgreSqlContainer().start();

  // Run migrations
  const databasePath = path.resolve(__dirname, "../../../database");

  execSync(`npx prisma db push --schema ${databasePath}/prisma/schema.prisma`, {
    env: {
      ...process.env,
      DATABASE_URL: container.getConnectionUri(),
      DIRECT_URL: container.getConnectionUri(),
    },
  });

  // console.log(container.getConnectionUri());

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: container.getConnectionUri(),
      },
    },
  });
  prisma.$connect();

  return { prisma, container };
}

export async function createTestRedisClient() {
  const container = await new RedisContainer().start();
  try {
    const client = new Redis({
      host: container.getHost(),
      port: container.getPort(),
      password: container.getPassword(),
    });
    return { client, container };
  } catch (e) {
    console.error(e);
    throw e;
  }
}
