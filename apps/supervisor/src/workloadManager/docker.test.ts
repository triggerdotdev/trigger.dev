import "./testEnvironment.js";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import Docker from "dockerode";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WorkloadManagerCreateOptions } from "./types.js";

// Static registry credentials keep a failed pull from asking ECR for a token.
Object.assign(process.env, {
  DOCKER_REGISTRY_USERNAME: "test",
  DOCKER_REGISTRY_PASSWORD: "test",
  DOCKER_REGISTRY_URL: "registry.example.com",
  DOCKER_RUNNER_NETWORKS: "host",
  DOCKER_ENFORCE_MACHINE_PRESETS: "1",
});
delete process.env.DOCKER_PLATFORM;
delete process.env.DOCKER_API_VERSION;

const { DockerWorkloadManager } = await import("./docker.js");
const { WorkloadNotCreatedError } = await import("./createErrors.js");

const docker = new Docker();
const daemon = await Promise.race([
  docker.ping().then(
    () => true,
    () => false
  ),
  setTimeout(5_000, false),
]);

/**
 * An image with nothing in it and a command that cannot run: creates succeed, starts are refused.
 * Its label reaches its containers, so `docker container prune` and `docker image prune -a`, both
 * with `--filter label=supervisor-test`, sweep what an interrupted run leaves behind.
 */
const IMAGE = `supervisor-test/empty:${randomUUID().slice(0, 8)}`;

const containers: string[] = [];

function createOptions(overrides: Partial<WorkloadManagerCreateOptions> = {}) {
  const runId = randomUUID().slice(0, 8);
  containers.push(`runner-${runId}`);
  return {
    image: IMAGE,
    machine: { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0 },
    version: "20261027.1",
    nextAttemptNumber: 1,
    dequeuedAt: new Date(),
    envId: "env_1",
    envType: "PRODUCTION",
    orgId: "org_1",
    projectId: "proj_1",
    deploymentFriendlyId: "deployment_1",
    deploymentVersion: "20261027.1",
    runId,
    runFriendlyId: `run_${runId}`,
    snapshotId: "snapshot1",
    snapshotFriendlyId: "snapshot_1",
    ...overrides,
  } as WorkloadManagerCreateOptions;
}

const tinyMemory = { name: "micro", cpu: 0.5, memory: 1 / 1024, centsPerMs: 0 } as const;

/** A manager whose client talks to `dockerHost`, or to the daemon the tests use when unset. */
function manager(
  releaseUnstartedRuns: boolean,
  { dockerHost, dockerAutoremove = false }: { dockerHost?: string; dockerAutoremove?: boolean } = {}
) {
  const previous = process.env.DOCKER_HOST;
  if (dockerHost) process.env.DOCKER_HOST = dockerHost;
  try {
    return new DockerWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: 8020,
      dockerAutoremove,
      releaseUnstartedRuns,
    });
  } finally {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previous;
  }
}

function containerExists(name: string) {
  return docker
    .getContainer(name)
    .inspect()
    .then(
      () => true,
      (error: { statusCode?: number }) => (error.statusCode === 404 ? false : Promise.reject(error))
    );
}

/** Where the daemon the tests use listens, as dockerode resolved it. */
const daemonEndpoint = await (async () => {
  const modem = docker.modem as unknown as {
    host?: string;
    port?: number;
    getSocketPath(): Promise<string>;
  };
  return modem.host
    ? { host: modem.host, port: Number(modem.port) }
    : { path: await modem.getSocketPath() };
})();

type Fault = { when: RegExp; lose: "request" | "response" };

/**
 * A TCP proxy to the daemon that loses one request's traffic, as a flaky network would: either
 * the request never reaches the daemon, or the daemon acts on it and its answer is lost.
 */
async function faultyProxy(fault: Fault) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(daemonEndpoint);
    sockets.add(client).add(upstream);
    let losing = false;
    client.on("data", (chunk) => {
      const [line] = chunk.toString("latin1").split("\r\n", 1);
      const request = /^([A-Z]+) (\S+) HTTP\//.exec(line ?? "");
      if (request) {
        losing = fault.when.test(`${request[1]} ${request[2]}`);
        if (losing && fault.lose === "request") {
          client.destroy();
          upstream.destroy();
          return;
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (losing) {
        client.destroy();
        upstream.destroy();
        return;
      }
      client.write(chunk);
    });
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      from.on("error", () => to.destroy());
      from.on("close", () => to.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    dockerHost: `tcp://127.0.0.1:${port}`,
    // Idle keep-alive sockets would otherwise hold the server open.
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe.skipIf(!daemon)("DockerWorkloadManager against the local daemon", () => {
  beforeAll(async () => {
    const [repo, tag] = IMAGE.split(":");
    const imported = await docker.importImage(Readable.from([Buffer.alloc(1024)]), {
      repo,
      tag,
      changes: 'CMD ["/nonexistent"]\nLABEL supervisor-test=1',
    });
    for await (const chunk of imported) {
      // The daemon reports a failure after it has answered, as an error line in the stream.
      if (String(chunk).includes('"error"')) {
        throw new Error(`Importing ${IMAGE} failed: ${chunk}`);
      }
    }
  });

  afterAll(async () => {
    await docker.getImage(IMAGE).remove({ force: true });
  });

  afterEach(async () => {
    await Promise.all(
      containers.splice(0).map((name) =>
        docker
          .getContainer(name)
          .remove({ force: true })
          .catch(() => undefined)
      )
    );
  });

  describe("with releases off", () => {
    it("returns after a pull the daemon refused", async () => {
      const options = createOptions({ image: "Invalid/Repo:1" });

      await expect(manager(false).create(options)).resolves.toBeUndefined();
    });

    it("returns after a create the daemon refused, leaving no container", async () => {
      const options = createOptions({ machine: tinyMemory });

      await expect(manager(false).create(options)).resolves.toBeUndefined();

      expect(await containerExists(`runner-${options.runId}`)).toBe(false);
    });

    it("returns after a start the daemon refused, leaving the container", async () => {
      const options = createOptions();

      await expect(manager(false).create(options)).resolves.toBeUndefined();

      expect(await containerExists(`runner-${options.runId}`)).toBe(true);
    });
  });

  describe("with releases on", () => {
    it("reports a pull the daemon refused as nothing running", async () => {
      const options = createOptions({ image: "Invalid/Repo:1" });

      const failed = manager(true).create(options);

      await expect(failed).rejects.toBeInstanceOf(WorkloadNotCreatedError);
      await expect(failed).rejects.toMatchObject({ message: "Failed to pull image" });
    });

    it("reports a create the daemon refused as nothing running", async () => {
      const options = createOptions({ machine: tinyMemory });

      const failed = manager(true).create(options);

      await expect(failed).rejects.toBeInstanceOf(WorkloadNotCreatedError);
      await expect(failed).rejects.toMatchObject({ message: "Failed to create container" });
      expect(await containerExists(`runner-${options.runId}`)).toBe(false);
    });

    it.each([
      ["removes", false],
      ["finds the daemon removed", true],
    ])(
      "%s a container whose start the daemon refused, then reports nothing running",
      async (_name, dockerAutoremove) => {
        const options = createOptions();

        const failed = manager(true, { dockerAutoremove }).create(options);

        await expect(failed).rejects.toBeInstanceOf(WorkloadNotCreatedError);
        await expect(failed).rejects.toMatchObject({ message: "Failed to start container" });
        expect(await containerExists(`runner-${options.runId}`)).toBe(false);
      }
    );

    it("returns after a name already in use, keeping that container", async () => {
      const options = createOptions();
      await docker.createContainer({ name: `runner-${options.runId}`, Image: IMAGE });

      await expect(manager(true).create(options)).resolves.toBeUndefined();

      expect(await containerExists(`runner-${options.runId}`)).toBe(true);
    });

    it("returns after a start whose answer was lost, keeping the container", async () => {
      const proxy = await faultyProxy({
        when: /^POST .*\/containers\/.*\/start/,
        lose: "response",
      });
      try {
        const options = createOptions();

        await expect(
          manager(true, { dockerHost: proxy.dockerHost }).create(options)
        ).resolves.toBeUndefined();

        expect(await containerExists(`runner-${options.runId}`)).toBe(true);
      } finally {
        await proxy.close();
      }
    });

    it("returns after a refused start whose container could not be removed, keeping it", async () => {
      const proxy = await faultyProxy({ when: /^DELETE .*\/containers\//, lose: "request" });
      try {
        const options = createOptions();

        await expect(
          manager(true, { dockerHost: proxy.dockerHost }).create(options)
        ).resolves.toBeUndefined();

        expect(await containerExists(`runner-${options.runId}`)).toBe(true);
      } finally {
        await proxy.close();
      }
    });
  });
});

describe("DockerWorkloadManager without a daemon", () => {
  it("returns when the daemon cannot be reached", async () => {
    const unreachable = manager(true, { dockerHost: "tcp://127.0.0.1:1" });

    await expect(unreachable.create(createOptions())).resolves.toBeUndefined();
  });
});
