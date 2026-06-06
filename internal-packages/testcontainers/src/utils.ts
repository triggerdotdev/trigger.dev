import { createClient } from "@clickhouse/client";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { tryCatch } from "@trigger.dev/core";
import Redis from "ioredis";
import path from "path";
import { isDebug } from "std-env";
import { GenericContainer, StartedNetwork, StartedTestContainer, Wait } from "testcontainers";
import { x } from "tinyexec";
import type { TestContext } from "vitest";
import { ClickHouseContainer, runClickhouseMigrations } from "./clickhouse";
import { MinIOContainer } from "./minio";
import { getContainerMetadata, getTaskMetadata, logCleanup, logSetup } from "./logs";

/** Returns the container's connection URI with the database path swapped to `database`. */
export function postgresUriWithDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Pushes the Prisma schema into the database at `databaseUrl` (creating it if missing). */
export async function pushDatabaseSchema(databaseUrl: string) {
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
          DATABASE_URL: databaseUrl,
          DIRECT_URL: databaseUrl,
        },
      },
    }
  );
}

/**
 * Caps each container's CPU/memory to approximate the 2-core CI runner locally (for timing + flake
 * reproduction). Set TESTCONTAINERS_CPU (cores per container, e.g. "2") and/or
 * TESTCONTAINERS_MEMORY_GB (GB per container). Pair with running the runner under `taskset -c 0,1`.
 * No-op when neither is set. (testcontainers v11 has no cpuset pinning, only this quota cap.)
 */
export function withCiResourceLimits<T extends GenericContainer>(container: T): T {
  const cpu = process.env.TESTCONTAINERS_CPU;
  const memory = process.env.TESTCONTAINERS_MEMORY_GB;
  if (!cpu && !memory) {
    return container;
  }
  return container.withResourcesQuota({
    ...(cpu ? { cpu: Number(cpu) } : {}),
    ...(memory ? { memory: Number(memory) } : {}),
  });
}

export async function createPostgresContainer(network: StartedNetwork) {
  const container = await withCiResourceLimits(new PostgreSqlContainer("docker.io/postgres:14"))
    .withNetwork(network)
    .withNetworkAliases("database")
    .withCommand(["-c", "listen_addresses=*", "-c", "wal_level=logical"])
    .start();

  await pushDatabaseSchema(container.getConnectionUri());

  return { url: container.getConnectionUri(), container, network };
}

export async function createClickHouseContainer(network: StartedNetwork) {
  const container = await withCiResourceLimits(new ClickHouseContainer())
    .withNetwork(network)
    .start();

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
  let container = withCiResourceLimits(new RedisContainer("redis:7.2"))
    .withExposedPorts(port ?? 6379)
    .withStartupTimeout(120_000); // 2 minutes

  if (network) {
    container = container.withNetwork(network).withNetworkAliases("redis");
  }

  // Wait only on the readiness log (RedisContainer's default) - the previous Docker healthcheck added
  // a full poll-cycle of latency per boot, which dominates per-test redis. verifyRedisConnection
  // below still confirms the container actually accepts connections before we hand it to the test.
  const startedContainer = await container
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  // Add a verification step
  const [error] = await tryCatch(verifyRedisConnection(startedContainer));

  if (error) {
    await startedContainer.stop({ timeout: 30_000 });
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

  const container = await withCiResourceLimits(
    new GenericContainer(
      "electricsql/electric:1.2.4@sha256:20da3d0b0e74926c5623392db67fd56698b9e374c4aeb6cb5cadeb8fea171c36"
    )
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

export async function createMinIOContainer(network: StartedNetwork) {
  const container = await withCiResourceLimits(new MinIOContainer())
    .withNetwork(network)
    .withNetworkAliases("minio")
    .start();

  return {
    container,
    network,
  };
}

export function assertNonNullable<T>(value: T): asserts value is NonNullable<T> {
  // Plain throw — *not* `vitest.expect`. Two reasons:
  //   1. This module is imported by globalSetup files that run before any
  //      vitest worker exists, so `import { expect }` from "vitest" at
  //      top level can crash on init.
  //   2. Lazy-loading via `require("vitest")` (the prior fix) collides
  //      with OTel auto-instrumentation: `@opentelemetry/instrumentation`
  //      hooks `require()` via `require-in-the-middle`, and vitest is
  //      ESM-only — the require() throws "Vitest cannot be imported in
  //      a CommonJS module using require()", failing every test that
  //      uses `assertNonNullable` after OTel's been touched.
  // The plain throw still gives vitest a useful failure (the message is
  // shown in the stack trace) without the instrumentation hazard.
  if (value === null || value === undefined) {
    throw new Error(`assertNonNullable: value was ${value === null ? "null" : "undefined"}`);
  }
}

export async function withContainerSetup<T>({
  name,
  task,
  setup,
}: {
  name: string;
  task: TestContext["task"];
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
  }: { container: TContainer; task: TestContext["task"]; use: () => Promise<void> }
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
    // Containers are throwaway, so we force-kill (SIGKILL) instead of waiting for a graceful
    // shutdown - ClickHouse alone spends ~5s/test gracefully stopping. timeout: 0 = immediate kill.
    // We still await it (no pileup); logCleanup swallows any teardown-time connection errors.
    await logCleanup(name, container.stop({ timeout: 0 }), metadata);
  }
}
