import { createRedisClient, type RedisClient, type RedisOptions } from "@internal/redis";
import { onTestFinished, expect } from "vitest";
import { waitpointKeys } from "../../waitpointCoordinator/keys.js";
import { WaitpointStoreCoordinator } from "../../waitpointCoordinator/storeCoordinator.js";

const access = new WeakMap<
  WaitpointStoreCoordinator,
  { admin: RedisClient; client: RedisClient; user: string }
>();

/** A real store connection with an owned ACL user, independent from the engine's queues/snapshots. */
export async function createTestStore(redisOptions: RedisOptions) {
  const admin = createRedisClient(redisOptions);
  const user = `waitpoint_test_${crypto.randomUUID()}`;
  const password = crypto.randomUUID();
  await admin.call("ACL", "SETUSER", user, "on", `>${password}`, "~*", "+@all");
  const client = createRedisClient({ ...redisOptions, username: user, password });
  const store = new WaitpointStoreCoordinator({ client });
  access.set(store, { admin, client, user });
  // The isolated fixture may already have stopped Redis when onTestFinished runs. The explicit
  // finally cleanup below removes the user while Redis is live; this fallback only closes sockets.
  onTestFinished(() => {
    client.disconnect();
    admin.disconnect();
  });
  return store;
}

export async function disableStoreAccess(store: WaitpointStoreCoordinator) {
  const { admin, user } = access.get(store)!;
  // Establish the connection before denying commands; quit remains available for ordinary cleanup.
  await store.readBlockState("acl_connection_ready");
  await admin.call("ACL", "SETUSER", user, "-@all", "+quit", "+ping");
}

export async function rejectStoreCommand<T>(
  store: WaitpointStoreCoordinator,
  command: string,
  operation: () => Promise<T>
) {
  const { admin, user } = access.get(store)!;
  await admin.call("ACL", "SETUSER", user, `-${command}`);
  try {
    await expect(operation()).rejects.toThrow(/ACL|permission|NOPERM/);
  } finally {
    await admin.call("ACL", "SETUSER", user, "+@all");
  }
}

export async function rejectWatcherWithdrawal<T>(
  store: WaitpointStoreCoordinator,
  operation: () => Promise<T>
) {
  const { admin, user } = access.get(store)!;
  // Run-side retain/clear remains writable; the cross-shard watcher withdrawal is denied by Redis.
  await admin.call("ACL", "SETUSER", user, "resetkeys", "%R~*", "~wp:v1:run:*");
  try {
    await expect(operation()).rejects.toThrow(/ACL|permission|NOPERM/);
  } finally {
    await admin.call("ACL", "SETUSER", user, "resetkeys", "~*");
  }
}

export async function rejectRegistration<T>(
  store: WaitpointStoreCoordinator,
  waitpointId: string,
  operation: () => Promise<T>
) {
  const { admin } = access.get(store)!;
  const key = waitpointKeys(waitpointId).watchers;
  expect(
    await admin.exists(key),
    "registration fault requires a source with no existing watchers"
  ).toBe(0);
  await admin.set(key, "wrong-type");
  try {
    await expect(operation()).rejects.toThrow("WRONGTYPE");
  } finally {
    await admin.del(key);
  }
}

export async function restoreStoreAccess(store: WaitpointStoreCoordinator) {
  const { admin, user } = access.get(store)!;
  await admin.call("ACL", "SETUSER", user, "+@all", "resetkeys", "~*");
}

export async function quitTestStore(store: WaitpointStoreCoordinator) {
  const owned = access.get(store);
  if (!owned) return;
  try {
    await owned.client.quit();
    await owned.admin.call("ACL", "DELUSER", owned.user);
  } finally {
    owned.client.disconnect();
    owned.admin.disconnect();
    access.delete(store);
  }
}
