import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import path from "path";
import { GenericContainer, StartedNetwork } from "testcontainers";
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

export async function createRedisContainer() {
  const container = await new RedisContainer().start();

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

  const container = await new GenericContainer("electricsql/electric:0.7.5")
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
