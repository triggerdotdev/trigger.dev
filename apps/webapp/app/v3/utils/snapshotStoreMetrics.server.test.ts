import { expect, test } from "vitest";
import { Registry } from "prom-client";
import { createSnapshotStoreMetrics } from "./snapshotStoreMetrics.server";
import { createSnapshotConnection, snapshotClusterOptions } from "./snapshotStoreConnection.server";

test("snapshot metrics ignore raw organization IDs; the endpoint creates no eager connection", async () => {
  const register = new Registry();
  const metrics = createSnapshotStoreMetrics(register);
  metrics.store.recordAppend("written", "terminal", "private-organization-id");
  metrics.decorator.recordWrite("written");
  const exposition = await register.metrics();
  expect(exposition).not.toContain("private-organization-id");
  expect(exposition).toContain('snapshot_store_write_total{outcome="written"} 1');

  const options = snapshotClusterOptions("rediss://snapshot.example:6379");
  expect(options.failFast).toBe(true);
  expect(options.clusterOptions).toMatchObject({ lazyConnect: true, scaleReads: "master" });
  expect(options.redisOptions.tls).toEqual({ servername: "snapshot.example" });
  expect(options.clusterOptions.dnsLookup).toBeTypeOf("function");
  options.clusterOptions.dnsLookup!("snapshot.example", (error, address) => {
    expect(error).toBeNull();
    expect(address).toBe("snapshot.example");
  });
  const plainOptions = snapshotClusterOptions("redis://127.0.0.1:1");
  expect(plainOptions.clusterOptions).toEqual({ lazyConnect: true, scaleReads: "master" });
  expect(plainOptions.redisOptions.tls).toBeUndefined();
  expect(options.redisOptions.commandTimeout).toBe(500);
  const connection = createSnapshotConnection("redis://127.0.0.1:1");
  connection.getStore(); // Registers local Lua commands only.
  expect(connection.getClient().status).toBe("wait");
  await connection.close(); // No connection attempt needed to close an unused lazy client.
});
