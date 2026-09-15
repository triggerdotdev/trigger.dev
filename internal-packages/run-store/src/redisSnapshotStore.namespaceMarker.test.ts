import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { protocolMarkerKey } from "./snapshotKeys.js";
import { createRedisClient } from "@internal/redis";

// The durable namespace/protocol marker, proven on real Redis: it bootstraps atomically when absent and
// must exactly match the build's protocol version otherwise. A mismatch is incompatible (fail closed).
describe("RedisSnapshotStore namespace protocol marker", () => {
  redisTest("bootstraps the marker when absent, then is compatible", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const first = await store.readOrBootstrapProtocolMarker("1");
      expect(first).toEqual({ compatible: true, stored: "1" });
      // A second probe reads the already-bootstrapped value, not a re-bootstrap.
      const second = await store.readOrBootstrapProtocolMarker("1");
      expect(second).toEqual({ compatible: true, stored: "1" });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "is incompatible when the stored marker differs from the build version",
    async ({ redisOptions }) => {
      // Pre-seed a cluster bootstrapped by an OLDER build at protocol "1".
      const seed = createRedisClient(redisOptions);
      await seed.set(protocolMarkerKey(), "1");
      await seed.quit();

      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        // This build speaks protocol "2": the existing marker must NOT be overwritten, and it is incompatible.
        const r = await store.readOrBootstrapProtocolMarker("2");
        expect(r).toEqual({ compatible: false, stored: "1" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("the marker never expires (no TTL)", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const probe = createRedisClient(redisOptions);
    try {
      await store.readOrBootstrapProtocolMarker("1");
      // -1 = the key exists with no expiry.
      expect(await probe.pttl(protocolMarkerKey())).toBe(-1);
    } finally {
      await probe.quit();
      await store.quit();
    }
  });
});
