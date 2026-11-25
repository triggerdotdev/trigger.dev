import { connect } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { hasLocalRedisServer, startLocalRedisCluster } from "@internal/testcontainers";
import { StoreWaitpointCoordinator } from "@internal/run-engine";
import { isInfrastructureError, WebhookInfrastructureError } from "@internal/webhook-engine";
import {
  completionFailureIsInfrastructure,
  retryingStoreOutage,
} from "~/v3/webhookPortErrors.server";
import {
  createWaitpointStoreConnection,
  waitpointClusterOptions,
} from "~/v3/utils/waitpointStoreConnection.server";

// Exercise actual connection lifecycles rather than the webapp singleton stubs.
vi.unmock("ioredis");

describe("waitpointStoreConnection.server", () => {
  test.skipIf(!hasLocalRedisServer())(
    "lazy catalog methods mint and list native MANUAL tokens through the real connection",
    async () => {
      const cluster = await startLocalRedisCluster();
      let activations = 0;
      const connection = createWaitpointStoreConnection(
        `redis://127.0.0.1:${cluster.nodes[0]!.port}`,
        { onActivate: () => activations++ }
      );
      try {
        const catalog = connection.store.manualCatalog;
        expect(activations).toBe(0);

        const adapter = new StoreWaitpointCoordinator({ store: connection.store });
        const created = await adapter.createManualWaitpoint({
          runId: "run_catalog_proxy",
          environmentId: "env_catalog_proxy",
          projectId: "proj_catalog_proxy",
          mintContext: { organizationId: "org_catalog_proxy" },
        });
        expect(created.kind).toBe("created");
        const list = catalog.list;
        const rows = await list({
          organizationId: "org_catalog_proxy",
          environmentId: "env_catalog_proxy",
          direction: "forward",
          limit: 10,
        });
        expect(rows.records.map((row) => row.record.id)).toEqual([created.waitpoint.id]);
        expect(await catalog.getManifest("org_catalog_proxy", created.waitpoint.id)).toBeDefined();
        expect(activations).toBe(1);
        // Consumer shutdown must leave the shared connection under its owner's lifecycle.
        await connection.store.quit();
        expect(
          (
            await list({
              organizationId: "org_catalog_proxy",
              environmentId: "env_catalog_proxy",
              direction: "forward",
              limit: 10,
            })
          ).records
        ).toHaveLength(1);
      } finally {
        await connection.close();
        await connection.close();
        await cluster.stop();
      }
    },
    30_000
  );

  // Catches: a whole-cluster outage reaching the webhook engine as an ordinary error with standalone
  // tokens on, which fails deliveries, or any change to how it is reported with them off.
  test.skipIf(!hasLocalRedisServer())(
    "the webhook ports report a whole-cluster store outage as infrastructure only with standalone tokens on",
    async () => {
      const cluster = await startLocalRedisCluster();
      const connection = createWaitpointStoreConnection(
        `redis://127.0.0.1:${cluster.nodes[0]!.port}`
      );
      try {
        const adapter = new StoreWaitpointCoordinator({ store: connection.store });
        const create = () =>
          adapter.createManualWaitpoint({
            runId: "run_outage",
            environmentId: "env_outage",
            projectId: "proj_outage",
            mintContext: { organizationId: "org_outage" },
          });
        expect((await create()).kind).toBe("created");

        const rejection = () =>
          create().then(
            () => undefined,
            (error: unknown) => error
          );

        for (const node of cluster.nodes) cluster.kill(node.port);
        // Sent before the client sees the outage, so it is already on a socket when the nodes die.
        const atOnset = await rejection();

        const refuses = (port: number) =>
          new Promise<boolean>((resolve) => {
            const socket = connect(port, "127.0.0.1");
            socket.once("connect", () => {
              socket.destroy();
              resolve(false);
            });
            socket.once("error", () => resolve(true));
          });
        await vi.waitFor(
          async () => {
            for (const node of cluster.nodes) expect(await refuses(node.port)).toBe(true);
          },
          { timeout: 10_000, interval: 50 }
        );
        // Sent once the client has seen the outage, so it waits for the connection and gives up.
        const later = await rejection();

        const bug = new Error("not an outage");
        for (const error of [atOnset, later]) {
          expect(error).toBeInstanceOf(Error);
          const fail = () => Promise.reject(error);
          // Off: the port call fails and is classified exactly as before.
          await expect(retryingStoreOutage(false, fail)).rejects.toBe(error);
          expect(completionFailureIsInfrastructure(error, false)).toBe(
            isInfrastructureError(error)
          );
          // On: an infrastructure failure, which the webhook engine retries.
          const translated = await retryingStoreOutage(true, fail).catch((e: unknown) => e);
          expect(translated).toBeInstanceOf(WebhookInfrastructureError);
          expect(isInfrastructureError(translated)).toBe(true);
          expect(completionFailureIsInfrastructure(error, true)).toBe(true);
        }
        await expect(retryingStoreOutage(true, () => Promise.reject(bug))).rejects.toBe(bug);
        expect(completionFailureIsInfrastructure(bug, true)).toBe(false);
      } finally {
        await connection.close();
        await cluster.stop();
      }
    },
    30_000
  );

  // Catches: the outage missed when ioredis wraps it after exhausting its redirections, which fails a
  // final-attempt completion instead of retrying it.
  test("a store outage wrapped by ioredis's redirection limit is still an outage", async () => {
    // Built as ioredis 5.6 Cluster#handleError builds it: a new Error, with no cause.
    const wrapped = new Error(
      "Too many Cluster redirections. Last error: " +
        new Error("Cluster isn't ready and enableOfflineQueue options is false")
    );
    expect(completionFailureIsInfrastructure(wrapped, false)).toBe(false);
    expect(completionFailureIsInfrastructure(wrapped, true)).toBe(true);
    await expect(retryingStoreOutage(true, () => Promise.reject(wrapped))).rejects.toBeInstanceOf(
      WebhookInfrastructureError
    );
    const unrelated = new Error("Too many Cluster redirections. Last error: Error: not an outage");
    expect(completionFailureIsInfrastructure(unrelated, true)).toBe(false);
  });

  // Catches: MemoryDB cluster options losing the TLS servername, credentials, fail-fast, lazy-connect or timeout settings.
  test("waitpoint MemoryDB configuration preserves the TLS hostname after slot discovery", () => {
    const options = waitpointClusterOptions("rediss://user:p%40ss@waitpoints.example:6380");
    expect(options.nodes).toEqual([{ host: "waitpoints.example", port: 6380 }]);
    expect(options.redisOptions.tls).toEqual({ servername: "waitpoints.example" });
    expect(options.redisOptions.username).toBe("user");
    expect(options.redisOptions.password).toBe("p@ss");
    expect(options.failFast).toBe(true);
    expect(options.clusterOptions.lazyConnect).toBe(true);
    expect(options.redisOptions.commandTimeout).toBe(2_000);
    expect(options.redisOptions.maxRetriesPerRequest).toBe(1);
  });

  // Catches: the waitpoint endpoint URL overriding the protocol, database index or connection options.
  test("waitpoint endpoint cannot override operational or database options", () => {
    for (const endpoint of [
      "https://waitpoints.example",
      "redis://waitpoints.example/1",
      "redis://waitpoints.example?lazyConnect=false",
    ]) {
      expect(() => waitpointClusterOptions(endpoint)).toThrow();
    }
  });

  // Catches: an unused waitpoint connection dialling MemoryDB, or a closed one staying usable.
  test("constructing and disposing an unused facade performs no connection attempt", async () => {
    const errors: Error[] = [];
    let activations = 0;
    const connection = createWaitpointStoreConnection("redis://127.0.0.1:1", {
      onError: (error) => errors.push(error),
      onActivate: () => activations++,
    });
    const probe = connection.store.probeWaitpointPresence;
    connection.onActivate(() => activations++);
    expect(typeof probe).toBe("function");
    await connection.store.quit();
    await connection.close();
    expect(errors).toEqual([]);
    expect(activations).toBe(0);
    expect(() => connection.store.probeWaitpointPresence("w_closed")).toThrow(
      "Waitpoint connection is closed"
    );
  });

  // Catches: an invalid waitpoint endpoint failing at startup instead of only when an enabled operation uses it.
  test("a configured invalid endpoint stays inert until an enabled operation invokes it", async () => {
    const connection = createWaitpointStoreConnection("invalid endpoint");
    const probe = connection.store.probeWaitpointPresence;
    expect(typeof probe).toBe("function");
    await connection.store.quit();
    expect(() => probe("w_invalid")).toThrow();
    await connection.close();
  });

  // Catches: logging or serializing the waitpoint store facade activating its connection.
  test("serialization, string conversion and unknown property inspection leave an invalid endpoint inert", async () => {
    let activations = 0;
    const connection = createWaitpointStoreConnection("invalid endpoint", {
      onActivate: () => activations++,
    });
    expect(JSON.stringify(connection.store)).toBe("{}");
    expect(String(connection.store)).toBe("[object WaitpointStoreCoordinator]");
    const inspected = connection.store as unknown as Record<string, unknown>;
    expect(inspected.toJSON).toBeUndefined();
    expect(inspected.constructor).toBeUndefined();
    expect(inspected.unknownMethod).toBeUndefined();
    const catalog = connection.store.manualCatalog;
    expect(typeof catalog.publish).toBe("function");
    expect(typeof catalog.list).toBe("function");
    expect(JSON.stringify(catalog)).toBe("{}");
    expect(String(catalog)).toBe("[object ManualWaitpointCatalog]");
    const inspectedCatalog = catalog as unknown as Record<PropertyKey, unknown>;
    expect(inspectedCatalog.then).toBeUndefined();
    expect(inspectedCatalog.toJSON).toBeUndefined();
    expect(inspectedCatalog.constructor).toBeUndefined();
    expect(inspectedCatalog.unknownMethod).toBeUndefined();
    expect(inspectedCatalog[Symbol.toStringTag]).toBeUndefined();
    expect(activations).toBe(0);
    await connection.close();
  });
});
