import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
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

export async function createRedisContainer({
  port,
  network,
}: {
  port?: number;
  network?: StartedNetwork;
}) {
  let container = new RedisContainer().withExposedPorts(port ?? 6379).withStartupTimeout(120_000); // 2 minutes

  if (network) {
    container = container.withNetwork(network).withNetworkAliases("redis");
  }

  const startedContainer = await container
    .withHealthCheck({
      test: ["CMD", "redis-cli", "ping"],
      interval: 1000,
      timeout: 3000,
      retries: 5,
    })
    .withWaitStrategy(
      Wait.forAll([Wait.forHealthCheck(), Wait.forLogMessage("Ready to accept connections")])
    )
    .start();

  // Add a verification step
  await verifyRedisConnection(startedContainer);

  return {
    container: startedContainer,
  };
}

async function verifyRedisConnection(container: StartedRedisContainer) {
  const redis = new Redis({
    host: container.getHost(),
    port: container.getPort(),
    password: container.getPassword(),
    maxRetriesPerRequest: 20,
    connectTimeout: 10000,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  const containerMetadata = {
    containerId: container.getId().slice(0, 12),
    containerName: container.getName(),
    containerNetworkNames: container.getNetworkNames(),
  };

  redis.on("error", (error) => {
    console.log("verifyRedisConnection error", error, containerMetadata);
  });

  try {
    await redis.ping();
  } finally {
    await redis.quit();
  }
}

export async function createElectricContainer(
  postgresContainer: StartedPostgreSqlContainer,
  network: StartedNetwork
) {
  const databaseUrl = `postgresql://${postgresContainer.getUsername()}:${postgresContainer.getPassword()}@${postgresContainer.getIpAddress(
    network.getName()
  )}:5432/${postgresContainer.getDatabase()}?sslmode=disable`;

  const container = await new GenericContainer(
    "electricsql/electric:1.0.0-beta.15@sha256:4ae0f895753b82684aa31ea1c708e9e86d0a9bca355acb7270dcb24062520810"
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
