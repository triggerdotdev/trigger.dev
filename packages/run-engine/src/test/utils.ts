import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { execSync } from "child_process";
import path from "path";

export async function createPostgresContainer() {
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

  return { url: container.getConnectionUri(), container };
}

export async function createRedisContainer() {
  const container = await new RedisContainer().start();
  try {
    return {
      container,
    };
  } catch (e) {
    console.error(e);
    throw e;
  }
}
