import { createClient } from "@clickhouse/client";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { tryCatch } from "@trigger.dev/core";
import Redis from "ioredis";
import path from "path";
import { isDebug } from "std-env";
import { GenericContainer, StartedNetwork, StartedTestContainer, Wait } from "testcontainers";
import { x } from "tinyexec";
import { expect, TaskContext } from "vitest";
import { ClickHouseContainer, runClickhouseMigrations } from "./clickhouse";
import { getContainerMetadata, getTaskMetadata, logCleanup, logSetup } from "./logs";

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

export async function createClickHouseContainer(network: StartedNetwork) {
  const container = await new ClickHouseContainer().withNetwork(network).start();

  const client = createClient({
    url: container.getConnectionUrl(),
  });

  await client.ping();

  // Now we run the migrations
  const migrationsPath = path.resolve(__dirname, "../../clickhouse/schema");

  await runClickhouseMigrations(client, migrationsPath);

  return {
    url: container.getConnectionUrl(),
    container,
    network,
  };
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
  const [error] = await tryCatch(verifyRedisConnection(startedContainer));

  if (error) {
    await startedContainer.stop({ timeout: 30 });
    throw new Error("verifyRedisConnection error", { cause: error });
  }

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
    if (isDebug) {
      console.log("verifyRedisConnection: client error", error, containerMetadata);
    }

    // Don't throw here, we'll do that below if the ping fails
  });

  try {
    await redis.ping();
  } catch (error) {
    if (isDebug) {
      console.log("verifyRedisConnection: ping error", error, containerMetadata);
    }

    throw new Error("verifyRedisConnection: ping error", { cause: error });
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
    "electricsql/electric:1.1.14@sha256:784495364583e0675c29f62d3f45ae76ee6e65ea5ad5eec7ae10293f5e439c89"
  )
    .withExposedPorts(3000)
    .withNetwork(network)
    .withEnvironment({
      DATABASE_URL: databaseUrl,
      ELECTRIC_INSECURE: "true",
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

export async function withContainerSetup<T>({
  name,
  task,
  setup,
}: {
  name: string;
  task: TaskContext["task"];
  setup: Promise<T extends { container: StartedTestContainer } ? T : never>;
}): Promise<T & { metadata: Record<string, unknown> }> {
  const testName = task.name;
  logSetup(`${name}: starting`, { testName });

  const start = Date.now();
  const result = await setup;
  const startDurationMs = Date.now() - start;

  const metadata = {
    ...getTaskMetadata(task),
    ...getContainerMetadata(result.container),
    startDurationMs,
  };

  logSetup(`${name}: started`, metadata);

  return { ...result, metadata };
}

export async function useContainer<TContainer extends StartedTestContainer>(
  name: string,
  {
    container,
    task,
    use,
  }: { container: TContainer; task: TaskContext["task"]; use: () => Promise<void> }
) {
  const metadata = {
    ...getTaskMetadata(task),
    ...getContainerMetadata(container),
    useDurationMs: 0,
  };

  try {
    const start = Date.now();
    await use();
    const useDurationMs = Date.now() - start;
    metadata.useDurationMs = useDurationMs;
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second
    await logCleanup(name, container.stop({ timeout: 10 }), metadata);
  }
}
