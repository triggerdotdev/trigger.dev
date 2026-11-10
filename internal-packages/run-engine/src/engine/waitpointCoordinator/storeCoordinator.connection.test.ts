import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { waitpointKeys } from "./keys.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";

describe("storeCoordinator.connection", () => {
  redisTest(
    "an app-owned client checks readiness before writes and direct reads and remains open after coordinator drain",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      const username = `readiness_${crypto.randomUUID()}`;
      const password = crypto.randomUUID();
      await client.call("ACL", "SETUSER", username, "on", `>${password}`, "~*", "+@all");
      const readiness = createRedisClient({ ...redisOptions, username, password });
      await readiness.ping();
      const store = new WaitpointStoreCoordinator({
        client,
        beforeCommand: async () => {
          await readiness.ping();
        },
      });
      const id = "w_connection_gate";
      const input = {
        id,
        friendlyId: `waitpoint_${id}`,
        type: "DATETIME" as const,
        environmentId: "env_connection_gate",
        projectId: "proj_connection_gate",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userProvidedIdempotencyKey: false,
        tags: [],
      };
      try {
        await client.call("ACL", "SETUSER", username, "-ping");
        await expect(store.createIfAbsent({ record: input, status: "PENDING" })).rejects.toThrow(
          /ACL|permission|NOPERM/i
        );
        expect(await client.exists(waitpointKeys(id).record)).toBe(0);
        await client.call("ACL", "SETUSER", username, "+ping");
        await store.createIfAbsent({ record: input, status: "PENDING" });
        expect(await store.probeWaitpointPresence(id)).toBe("present");
        await client.call("ACL", "SETUSER", username, "-ping");
        await expect(store.probeWaitpointPresence(id)).rejects.toThrow(/ACL|permission|NOPERM/i);
        await expect(store.readCompletedRecords([id])).rejects.toThrow(/ACL|permission|NOPERM/i);
        await expect(store.readBlockHandoff("run_connection_gate")).rejects.toThrow(
          /ACL|permission|NOPERM/i
        );
        await store.quit();
        expect(await client.ping()).toBe("PONG");
      } finally {
        await store.quit();
        readiness.disconnect();
        await client.call("ACL", "DELUSER", username);
        await client.quit();
      }
    }
  );
});
