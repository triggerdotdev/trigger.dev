import { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@trigger.dev/database";
import { RedisOptions } from "ioredis";
import { Network, type StartedNetwork } from "testcontainers";
import { TaskContext, test } from "vitest";
import { createElectricContainer, createPostgresContainer, createRedisContainer } from "./utils";
import { x } from "tinyexec";
import { isCI, env } from "std-env";

export { assertNonNullable } from "./utils";
export { StartedRedisContainer };

type NetworkContext = { network: StartedNetwork };

type PostgresContext = NetworkContext & {
  postgresContainer: StartedPostgreSqlContainer;
  prisma: PrismaClient;
};

type RedisContext = NetworkContext & {
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
};

type ElectricContext = {
  electricOrigin: string;
};

type ContainerContext = NetworkContext & PostgresContext & RedisContext;
type ContainerWithElectricAndRedisContext = ContainerContext & ElectricContext;
type ContainerWithElectricContext = NetworkContext & PostgresContext & ElectricContext;

type Use<T> = (value: T) => Promise<void>;

let cleanupOrder = 0;
let activeCleanups = 0;

/**
 * Logs the cleanup of a resource.
 * @param resource - The resource that is being cleaned up.
 * @param promise - The cleanup promise to await..
 */
async function logCleanup(
  resource: string,
  promise: Promise<unknown>,
  metadata: Record<string, unknown> = {}
) {
  const start = new Date();
  const order = cleanupOrder++;
  const activeAtStart = ++activeCleanups;

  let error: unknown = null;

  try {
    await promise;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const end = new Date();
  const durationMs = end.getTime() - start.getTime();
  const activeAtEnd = --activeCleanups;
  const parallel = activeAtStart > 1 || activeAtEnd > 0;

  if (!isCI) {
    return;
  }

  let dockerDiagnostics: DockerDiagnostics = {};

  // Only run docker diagnostics if there was an error or cleanup took longer than 5s
  if (error || durationMs > 5000 || env.DOCKER_DIAGNOSTICS) {
    try {
      dockerDiagnostics = await getDockerDiagnostics();
    } catch (diagnosticErr) {
      console.error("Failed to get docker diagnostics:", diagnosticErr);
    }
  }

  console.log(
    JSON.stringify({
      type: "cleanup",
      order,
      resource,
      durationMs,
      start: start.toISOString(),
      end: end.toISOString(),
      parallel,
      error,
      activeAtStart,
      activeAtEnd,
      ...metadata,
      ...dockerDiagnostics,
    })
  );
}

function stringToLines(str: string): string[] {
  return str.split("\n").filter(Boolean);
}

function lineToWords(line: string): string[] {
  return line.trim().split(/\s+/);
}

async function getDockerNetworks(): Promise<string[]> {
  try {
    const result = await x("docker", ["network", "ls" /* , "--no-trunc" */]);
    return stringToLines(result.stdout);
  } catch (error) {
    console.error(error);
    return ["error: check additional logs for more details"];
  }
}

async function getDockerContainers(): Promise<string[]> {
  try {
    const result = await x("docker", ["ps", "-a" /* , "--no-trunc" */]);
    return stringToLines(result.stdout);
  } catch (error) {
    console.error(error);
    return ["error: check additional logs for more details"];
  }
}

type DockerResource = { id: string; name: string };

type DockerNetworkAttachment = DockerResource & {
  containers: string[];
};

export async function getDockerNetworkAttachments(): Promise<DockerNetworkAttachment[]> {
  let attachments: DockerNetworkAttachment[] = [];
  let networks: DockerResource[] = [];

  try {
    const result = await x("docker", [
      "network",
      "ls",
      "--format",
      '{{.ID | printf "%.12s"}} {{.Name}}',
    ]);

    const lines = stringToLines(result.stdout);

    networks = lines.map((line) => {
      const [id, name] = lineToWords(line);
      return { id, name };
    });
  } catch (err) {
    console.error("Failed to list docker networks:", err);
  }

  for (const { id, name } of networks) {
    try {
      // Get containers, one per line: id name\n
      const containersResult = await x("docker", [
        "network",
        "inspect",
        "--format",
        '{{range $k, $v := .Containers}}{{$k | printf "%.12s"}} {{$v.Name}}\n{{end}}',
        id,
      ]);

      const containers = stringToLines(containersResult.stdout);

      attachments.push({ id, name, containers });
    } catch (err) {
      console.error(`Failed to inspect network ${id}:`, err);
      attachments.push({ id, name, containers: [] });
    }
  }

  return attachments;
}

type DockerContainerNetwork = DockerResource & {
  networks: string[];
};

export async function getDockerContainerNetworks(): Promise<DockerContainerNetwork[]> {
  let results: DockerContainerNetwork[] = [];
  let containers: DockerResource[] = [];

  try {
    const result = await x("docker", [
      "ps",
      "-a",
      "--format",
      '{{.ID | printf "%.12s"}} {{.Names}}',
    ]);

    const lines = stringToLines(result.stdout);

    containers = lines.map((line) => {
      const [id, name] = lineToWords(line);
      return { id, name };
    });
  } catch (err) {
    console.error("Failed to list docker containers:", err);
  }

  for (const { id, name } of containers) {
    try {
      const inspectResult = await x("docker", [
        "inspect",
        "--format",
        '{{ range $k, $v := .NetworkSettings.Networks }}{{ $k | printf "%.12s" }} {{ $v.Name }}\n{{ end }}',
        id,
      ]);

      const networks = stringToLines(inspectResult.stdout);

      results.push({ id, name, networks });
    } catch (err) {
      console.error(`Failed to inspect container ${id}:`, err);
      results.push({ id, name: String(err), networks: [] });
    }
  }

  return results;
}

type DockerDiagnostics = {
  containers?: string[];
  networks?: string[];
  containerNetworks?: DockerContainerNetwork[];
  networkAttachments?: DockerNetworkAttachment[];
};

async function getDockerDiagnostics(): Promise<DockerDiagnostics> {
  const [containers, networks, networkAttachments, containerNetworks] = await Promise.all([
    getDockerContainers(),
    getDockerNetworks(),
    getDockerNetworkAttachments(),
    getDockerContainerNetworks(),
  ]);

  return {
    containers,
    networks,
    containerNetworks,
    networkAttachments,
  };
}

const network = async ({ task }: TaskContext, use: Use<StartedNetwork>) => {
  const testName = task.name;

  logSetup("network: starting", { testName });

  const start = Date.now();
  const network = await new Network().start();
  const startDurationMs = Date.now() - start;

  const metadata = {
    testName,
    networkId: network.getId().slice(0, 12),
    networkName: network.getName(),
    startDurationMs,
  };

  logSetup("network: started", metadata);

  try {
    await use(network);
  } finally {
    // Make sure to stop the network after use
    await logCleanup("network", network.stop(), metadata);
  }
};

const postgresContainer = async (
  { network, task }: { network: StartedNetwork } & TaskContext,
  use: Use<StartedPostgreSqlContainer>
) => {
  const testName = task.name;

  logSetup("postgresContainer: starting", { testName });

  const start = Date.now();
  const { container } = await createPostgresContainer(network);
  const startDurationMs = Date.now() - start;

  const metadata = {
    testName,
    containerId: container.getId().slice(0, 12),
    containerName: container.getName(),
    containerNetworkNames: container.getNetworkNames(),
    startDurationMs,
  };

  logSetup("postgresContainer: started", metadata);

  try {
    await use(container);
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second
    await logCleanup("postgresContainer", container.stop({ timeout: 30 }), metadata);
  }
};

const prisma = async (
  { postgresContainer, task }: { postgresContainer: StartedPostgreSqlContainer } & TaskContext,
  use: Use<PrismaClient>
) => {
  const testName = task.name;
  const url = postgresContainer.getConnectionUri();

  console.log("Initializing Prisma with URL:", url);

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
  });
  try {
    await use(prisma);
  } finally {
    await logCleanup("prisma", prisma.$disconnect(), { testName });
  }
};

export const postgresTest = test.extend<PostgresContext>({ network, postgresContainer, prisma });

let setupOrder = 0;

function logSetup(resource: string, metadata: Record<string, unknown>) {
  const order = setupOrder++;

  if (!isCI) {
    return;
  }

  console.log(
    JSON.stringify({
      type: "setup",
      order,
      resource,
      timestamp: new Date().toISOString(),
      ...metadata,
    })
  );
}

const redisContainer = async (
  { network, task }: { network: StartedNetwork } & TaskContext,
  use: Use<StartedRedisContainer>
) => {
  const testName = task.name;

  logSetup("redisContainer: starting", { testName });

  const start = Date.now();

  const { container } = await createRedisContainer({
    port: 6379,
    network,
  });

  const startDurationMs = Date.now() - start;

  const metadata = {
    containerName: container.getName(),
    containerId: container.getId().slice(0, 12),
    containerNetworkNames: container.getNetworkNames(),
    startDurationMs,
    testName,
  };

  logSetup("redisContainer: started", metadata);

  try {
    await use(container);
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second
    await logCleanup("redisContainer", container.stop({ timeout: 30 }), metadata);
  }
};

const redisOptions = async (
  { redisContainer }: { redisContainer: StartedRedisContainer },
  use: Use<RedisOptions>
) => {
  const options: RedisOptions = {
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
    password: redisContainer.getPassword(),
    maxRetriesPerRequest: 20, // Lower the retry attempts
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    connectTimeout: 10000, // 10 seconds
    // Add more robust connection options
    enableOfflineQueue: true,
    reconnectOnError: (err) => {
      const targetError = "READONLY";
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
    enableAutoPipelining: true,
    autoResubscribe: true,
    autoResendUnfulfilledCommands: true,
    lazyConnect: false,
    showFriendlyErrorStack: true,
  };

  await use(options);
};

export const redisTest = test.extend<RedisContext>({ network, redisContainer, redisOptions });

const electricOrigin = async (
  {
    postgresContainer,
    network,
    task,
  }: { postgresContainer: StartedPostgreSqlContainer; network: StartedNetwork } & TaskContext,
  use: Use<string>
) => {
  const testName = task.name;

  logSetup("electricOrigin: starting", { testName });

  const start = Date.now();
  const { origin, container } = await createElectricContainer(postgresContainer, network);
  const startDurationMs = Date.now() - start;

  const metadata = {
    testName,
    containerId: container.getId().slice(0, 12),
    containerName: container.getName(),
    startDurationMs,
  };

  logSetup("electricOrigin: started", metadata);

  try {
    await use(origin);
  } finally {
    // WARNING: Testcontainers by default will not wait until the container has stopped. It will simply issue the stop command and return immediately.
    // If you need to wait for the container to be stopped, you can provide a timeout. The unit of timeout option here is second
    await logCleanup("electricContainer", container.stop({ timeout: 30 }), metadata);
  }
};

export const containerTest = test.extend<ContainerContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
});

export const containerWithElectricTest = test.extend<ContainerWithElectricContext>({
  network,
  postgresContainer,
  prisma,
  electricOrigin,
});

export const containerWithElectricAndRedisTest = test.extend<ContainerWithElectricAndRedisContext>({
  network,
  postgresContainer,
  prisma,
  redisContainer,
  redisOptions,
  electricOrigin,
});
