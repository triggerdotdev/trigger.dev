import net from "node:net";
import { createRedisClient } from "@internal/redis";
import { isolatedRedisTest as redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { WaitpointKeyTransactionBudgetExhaustedError } from "@internal/run-store";
import { assertCreationBudget, withCreationBudget } from "./creationBudget.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { idempotencyClaimKey, idempotencyKey, waitpointKeys } from "./keys.js";

describe("creationBudget", () => {
  redisTest(
    "aggregate response latency stops keyed creation and recovery cannot publish a stale candidate",
    async ({ redisOptions }) => {
      let latency = 0;
      const sockets = new Set<net.Socket>();
      const pendingReplies = new Set<ReturnType<typeof setTimeout>>();
      const proxy = net.createServer((down) => {
        const up = net.connect(redisOptions.port!, redisOptions.host!);
        sockets.add(down);
        sockets.add(up);
        down.pipe(up);
        up.on("data", (data) => {
          const delay = latency;
          const reply = setTimeout(() => {
            pendingReplies.delete(reply);
            if (!down.destroyed) down.write(data);
          }, delay);
          pendingReplies.add(reply);
        });
        down.on("error", () => {});
        up.on("error", () => {});
        down.on("close", () => {
          up.destroy();
          sockets.delete(up);
          sockets.delete(down);
        });
        up.on("end", () => down.end());
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address() as net.AddressInfo;
      const store = new WaitpointStoreCoordinator({
        redisOptions: {
          ...redisOptions,
          host: "127.0.0.1",
          port: address.port,
          commandTimeout: 2000,
          connectTimeout: 1000,
          maxRetriesPerRequest: 1,
        },
      });
      const raw = createRedisClient(redisOptions);
      const candidateId = generateWaitpointId("DATETIME");
      const makeRecord = (id: string) => ({
        id,
        friendlyId: `waitpoint_${id}`,
        type: "DATETIME" as const,
        projectId: "p",
        environmentId: "e",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        userProvidedIdempotencyKey: true,
        completedAfter: new Date().toISOString(),
      });
      try {
        // Warm scripts/connections. The fault delays replies, each below commandTimeout.
        await store.beginIdempotencyKeyClaim({
          environmentId: "warm",
          idempotencyKey: "warm",
          token: "warm",
          acceptUntil: Date.now() + 60000,
        });
        await store.createWithIdempotencyKey({
          record: makeRecord(generateWaitpointId("DATETIME")),
          environmentId: "warm",
          idempotencyKey: "warm",
          claimToken: "warm",
        });
        const acceptUntil = Date.now() + 4500;
        latency = 1250;
        const began = Date.now();
        await expect(
          withCreationBudget(acceptUntil, async () => {
            await store.beginIdempotencyKeyClaim({
              environmentId: "e",
              idempotencyKey: "k",
              token: "old",
              acceptUntil,
            });
            await store.createWithIdempotencyKey({
              record: makeRecord(candidateId),
              environmentId: "e",
              idempotencyKey: "k",
              claimToken: "old",
              acceptUntil,
            });
          })
        ).rejects.toThrow(/timed out|budget exhausted/);
        expect(Date.now() - began).toBeLessThan(4900);
        latency = 0;
        // Allow every delayed reply/retry to arrive before inspecting durable state.
        await expect
          .poll(() => pendingReplies.size, {
            timeout: 2000,
            interval: 20,
            message: "delayed Redis replies never drained",
          })
          .toBe(0);
        expect(await raw.get(idempotencyKey("e", "k"))).toBeNull();
        expect(
          await store.recoverIdempotencyCandidate({
            candidateId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ winnerId: undefined });
        expect(await raw.exists(waitpointKeys(candidateId).record)).toBe(0);
        const winner = generateWaitpointId("DATETIME");
        // Flush the real script cache: ioredis must retry NOSCRIPT without changing the fence.
        await raw.script("FLUSH");
        const nextUntil = Date.now() + 4500;
        await withCreationBudget(nextUntil, async () => {
          await store.beginIdempotencyKeyClaim({
            environmentId: "e",
            idempotencyKey: "k",
            token: "next",
            acceptUntil: nextUntil,
          });
          await store.createWithIdempotencyKey({
            record: makeRecord(winner),
            environmentId: "e",
            idempotencyKey: "k",
            claimToken: "next",
            acceptUntil: nextUntil,
          });
        });
        // Expired foreground and recovery replay cannot replace the new winner.
        await expect(
          store.createWithIdempotencyKey({
            record: makeRecord(candidateId),
            environmentId: "e",
            idempotencyKey: "k",
            claimToken: "old",
            acceptUntil,
          })
        ).rejects.toThrow("closed");
        await store.recoverIdempotencyCandidate({
          candidateId,
          environmentId: "e",
          idempotencyKey: "k",
          acceptUntil,
        });
        expect(await raw.get(idempotencyKey("e", "k"))).toBe(winner);
        expect(await raw.exists(waitpointKeys(winner).record)).toBe(1);
        expect(await raw.exists(waitpointKeys(candidateId).record)).toBe(0);
      } finally {
        latency = 0;
        await store.quit();
        await raw.quit();
        for (const reply of pendingReplies) clearTimeout(reply);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    }
  );

  redisTest(
    "late read-only readiness cannot dispatch a claim after budget expiry or affect another caller",
    async ({ redisOptions }) => {
      const raw = createRedisClient(redisOptions);
      let prepared = false;
      const store = new WaitpointStoreCoordinator({
        redisOptions: { ...redisOptions, commandTimeout: 2000 },
        beforeCommand: async () => {
          await raw.info("memory");
          prepared = true;
        },
      });
      try {
        // Pause the isolated Redis itself so the real readiness read outlives this caller.
        await raw.call("CLIENT", "PAUSE", 500, "ALL");
        const acceptUntil = Date.now() + 100;
        const expired = withCreationBudget(acceptUntil, () =>
          store.beginIdempotencyKeyClaim({
            environmentId: "e",
            idempotencyKey: "expired",
            token: "expired",
            acceptUntil,
          })
        );
        // Catches: the engine's creation budget checks throwing a plain Error, which answers 500.
        await expect(expired).rejects.toBeInstanceOf(WaitpointKeyTransactionBudgetExhaustedError);
        await expect(
          withCreationBudget(Date.now() - 1, async () => assertCreationBudget())
        ).rejects.toBeInstanceOf(WaitpointKeyTransactionBudgetExhaustedError);
        // Same client, outside the explicit scope: another caller retains its own timeout.
        await expect(
          store.beginIdempotencyKeyClaim({
            environmentId: "e",
            idempotencyKey: "other",
            token: "other",
            acceptUntil: Date.now() + 60000,
          })
        ).resolves.toEqual({});
        await expect
          .poll(() => prepared, {
            timeout: 2000,
            interval: 20,
            message: "Redis readiness never completed after the expired creation budget",
          })
          .toBe(true);
        expect(await raw.get(idempotencyKey("e", "expired"))).toBeNull();
        expect(await raw.get(idempotencyClaimKey("e", "expired"))).toBeNull();
        expect(await store.readIdempotencyKey("e", "expired")).toBeUndefined();
      } finally {
        await store.quit();
        await raw.quit();
      }
    }
  );
});
