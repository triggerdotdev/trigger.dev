import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import path from "path";
import { GenericContainer, StartedNetwork, Wait } from "testcontainers";
import { x } from "tinyexec";
import { expect } from "vitest";

export async function createPostgresContainer(network: StartedNetwork) {
  const container = await new PostgreSqlContainer("docker.io/postgres:14")
    .withNetwork(network)
    .withNetworkAliases("database")
    .withCommand(["-c", "listen_addresses=*", "-c", "wal_level=logical"])
    .start();

  // Run migrations
  const databasePath = path.resolve(__dirname, "../../database");

  await x(
    `${databasePath}/node_modules/.bin/prisma`,
    [
      "db",
      "push",
      "--force-reset",
      "--accept-data-loss",
      "--skip-generate",
      "--schema",
      `${databasePath}/prisma/schema.prisma`,
    ],
    {
      nodeOptions: {
        env: {
          ...process.env,
          DATABASE_URL: container.getConnectionUri(),
          DIRECT_URL: container.getConnectionUri(),
        },
      },
    }
  );

  return { url: container.getConnectionUri(), container, network };
}

export async function createRedisContainer({ port }: { port?: number }) {
  const container = await new RedisContainer()
    .withExposedPorts(port ?? 6379)
    .withStartupTimeout(120_000) // 2 minutes
    .withHealthCheck({
      test: ["CMD", "redis-cli", "ping"],
      interval: 1000,
      timeout: 3000,
      retries: 5,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  return {
    container,
  };
}

export async function createElectricContainer(
  postgresContainer: StartedPostgreSqlContainer,
  network: StartedNetwork
) {
  const databaseUrl = `postgresql://${postgresContainer.getUsername()}:${postgresContainer.getPassword()}@${postgresContainer.getIpAddress(
    network.getName()
  )}:5432/${postgresContainer.getDatabase()}?sslmode=disable`;

  const container = await new GenericContainer(
    "electricsql/electric:1.0.0-beta.1@sha256:2262f6f09caf5fa45f233731af97b84999128170a9529e5f9b9b53642308493f"
  )
    .withExposedPorts(3000)
    .withNetwork(network)
    .withEnvironment({
      DATABASE_URL: databaseUrl,
    })
    .start();

  return {
    container,
    origin: `http://${container.getHost()}:${container.getMappedPort(3000)}`,
  };
}

export function assertNonNullable<T>(value: T): asserts value is NonNullable<T> {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
}
