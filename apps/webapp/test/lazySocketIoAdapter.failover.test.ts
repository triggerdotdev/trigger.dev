import { isolatedRedisTest } from "@internal/testcontainers";
import type { StartedRedisContainer } from "@internal/testcontainers";
import { defaultReconnectOnError } from "@internal/redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis, type RedisOptions } from "ioredis";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { Server } from "socket.io";
import { describe, expect, vi } from "vitest";
import { createLazySocketIoAdapter, withTimeout } from "~/v3/lazySocketIoAdapter.server";

vi.setConfig({ testTimeout: 90_000 });

const KEY = "tr:socket.io:";
const ADAPTER_OPTS = { key: KEY, publishOnSpecificResponseChannel: true } as const;
const REQUEST_CHANNEL = `${KEY}-request#/worker#`;
const ROOM = "room:run_failover";
/** Mirrors the webapp's connection middleware bound. */
const ACTIVATION_TIMEOUT_MS = 5_000;

type Mode = "lazy" | "eager";
type Cleanup = () => Promise<void> | void;

function tracker() {
  const cleanups: Cleanup[] = [];
  let done = false;
  return {
    add: (fn: Cleanup) => cleanups.push(fn),
    async run() {
      if (done) return;
      done = true;
      for (const fn of cleanups.reverse()) await fn();
    },
  };
}

/**
 * The production socket.io Redis client, minus TLS and auth: auto-pipelining,
 * the shared reconnectOnError, and ioredis defaults for everything that governs
 * recovery (autoResubscribe, autoResendUnfulfilledCommands, retryStrategy,
 * maxRetriesPerRequest). Built from host/port directly so no fixture wrapping
 * changes its connection behaviour.
 */
function prodShapedOptions(
  container: StartedRedisContainer,
  extra: RedisOptions = {}
): RedisOptions {
  return {
    host: container.getHost(),
    port: container.getPort(),
    password: container.getPassword() || undefined,
    enableAutoPipelining: true,
    reconnectOnError: defaultReconnectOnError,
    ...extra,
  };
}

function client(
  container: StartedRedisContainer,
  cleanup: ReturnType<typeof tracker>,
  extra: RedisOptions = {}
) {
  const c = new Redis(prodShapedOptions(container, extra));
  c.on("error", () => {});
  cleanup.add(async () => {
    await c.quit().catch(() => {});
  });
  return c;
}

async function numsub(control: Redis): Promise<number> {
  const res = (await control.pubsub("NUMSUB", REQUEST_CHANNEL)) as [string, number];
  return Number(res[1]);
}

/**
 * A node replacement as the client experiences it behind a stable endpoint:
 * every connection dropped and server state gone, at the same address.
 * Not `redisContainer.restart()`: docker remaps the host port on restart, so
 * clients would retry a dead port, which is the opposite of production's
 * stable DNS name and tests nothing about recovery.
 */
async function nodeSwap(control: Redis) {
  await control.flushall();
  await control.call("CLIENT", "KILL", "TYPE", "pubsub", "SKIPME", "yes");
  await control.call("CLIENT", "KILL", "TYPE", "normal", "SKIPME", "yes");
}

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

async function startServer(
  mode: Mode,
  container: StartedRedisContainer,
  cleanup: ReturnType<typeof tracker>
) {
  const pubClient = new Redis(prodShapedOptions(container));
  const subClient = pubClient.duplicate();
  pubClient.on("error", () => {});
  subClient.on("error", () => {});

  const lazy =
    mode === "lazy"
      ? createLazySocketIoAdapter(pubClient, subClient, { ...ADAPTER_OPTS })
      : undefined;
  const io = new Server({
    adapter: lazy ? lazy.adapter : createAdapter(pubClient, subClient, { ...ADAPTER_OPTS }),
  });

  const nsp = io.of("/worker");
  if (lazy) {
    nsp.use(async (_socket, next) => {
      try {
        await withTimeout(lazy.activate("/worker"), ACTIVATION_TIMEOUT_MS, "activation timed out");
        next();
      } catch (error) {
        next(error instanceof Error ? error : new Error("activation failed"));
      }
    });
  }
  nsp.on("connection", (socket) => {
    socket.on("join", (room: string, ack: () => void) => {
      socket.join(room);
      ack();
    });
  });

  const httpServer: HttpServer = createServer();
  io.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

  cleanup.add(async () => {
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise((r) => setImmediate(r));
    await subClient.quit().catch(() => {});
    await pubClient.ping().catch(() => {});
    await pubClient.quit().catch(() => {});
  });

  return { io, nsp, lazy, url, pubClient, subClient };
}

async function connectAndJoin(
  url: string,
  cleanup: ReturnType<typeof tracker>
): Promise<ClientSocket> {
  const socket = ioClient(`${url}/worker`, { transports: ["websocket"] });
  cleanup.add(() => {
    socket.disconnect();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  await new Promise<void>((resolve) => socket.emit("join", ROOM, resolve));
  return socket;
}

function expectDelivery(
  socket: ClientSocket,
  publisher: Server,
  payload: string,
  timeoutMs = 10_000
) {
  const received = new Promise<string>((resolve) =>
    socket.once("run:notify", (p: { id: string }) => resolve(p.id))
  );
  publisher.of("/worker").to(ROOM).emit("run:notify", { id: payload });
  return withTimeout(received, timeoutMs, `delivery of ${payload}`);
}

describe("lazy socket.io redis adapter under Redis failover", () => {
  for (const mode of ["lazy", "eager"] as const) {
    isolatedRedisTest(
      `[${mode}] subscriptions and delivery recover after every pub/sub connection is killed`,
      async ({ redisContainer }) => {
        const cleanup = tracker();
        try {
          const control = client(redisContainer, cleanup);
          const holder = await startServer(mode, redisContainer, cleanup);
          const publisher = await startServer(mode, redisContainer, cleanup);
          const socket = await connectAndJoin(holder.url, cleanup);

          /** Lazy: only the holder subscribes. Eager: both processes subscribe at construction. */
          const expected = mode === "lazy" ? 1 : 2;
          await waitFor(
            async () => (await numsub(control)) === expected,
            `${expected} subscriber(s) before the kill`
          );
          await expect(expectDelivery(socket, publisher.io, "before-kill")).resolves.toBe(
            "before-kill"
          );

          /** The node-swap shape: every subscriber connection is torn down server side. */
          const killed = Number(await control.call("CLIENT", "KILL", "TYPE", "pubsub"));
          expect(killed).toBeGreaterThanOrEqual(expected);
          await waitFor(
            async () => (await numsub(control)) === 0,
            "subscriptions to be gone (proves the kill)"
          );

          await waitFor(
            async () => (await numsub(control)) === expected,
            "ioredis to resubscribe after reconnect"
          );
          await expect(expectDelivery(socket, publisher.io, "after-kill")).resolves.toBe(
            "after-kill"
          );

          if (holder.lazy && publisher.lazy) {
            expect(holder.lazy.isActivated("/worker")).toBe(true);
            expect(publisher.lazy.isActivated("/worker")).toBe(false);
          }
        } finally {
          await cleanup.run();
        }
      }
    );

    isolatedRedisTest(
      `[${mode}] subscriptions and delivery recover after a node swap (every connection dropped, state wiped)`,
      async ({ redisContainer }) => {
        const cleanup = tracker();
        try {
          const control = client(redisContainer, cleanup);
          const holder = await startServer(mode, redisContainer, cleanup);
          const publisher = await startServer(mode, redisContainer, cleanup);
          const socket = await connectAndJoin(holder.url, cleanup);

          const expected = mode === "lazy" ? 1 : 2;
          await waitFor(
            async () => (await numsub(control)) === expected,
            `${expected} subscriber(s) before the swap`
          );
          await expect(expectDelivery(socket, publisher.io, "before-swap")).resolves.toBe(
            "before-swap"
          );

          await nodeSwap(control);
          await waitFor(
            async () => (await numsub(control)) === 0,
            "subscriptions to be gone (proves the swap)"
          );
          await waitFor(
            async () => (await numsub(control)) === expected,
            "subscriptions to be restored after the swap"
          );
          await expect(expectDelivery(socket, publisher.io, "after-swap")).resolves.toBe(
            "after-swap"
          );

          if (publisher.lazy) {
            expect(publisher.lazy.isActivated("/worker")).toBe(false);
          }
        } finally {
          await cleanup.run();
        }
      }
    );
  }

  isolatedRedisTest(
    "[lazy] an activation and a handshake that start during a Redis blackout complete once it lifts, and never hang",
    async ({ redisContainer }) => {
      const cleanup = tracker();
      try {
        const control = client(redisContainer, cleanup);
        const holder = await startServer("lazy", redisContainer, cleanup);
        const publisher = await startServer("lazy", redisContainer, cleanup);
        /** Warm the publisher's pub connection so its later broadcast is not itself delayed by connect. */
        await publisher.pubClient.ping();

        const PAUSE_MS = 1_500;
        /** Redis stops processing commands from every other connection; psubscribe from activation stalls. */
        await control.call("CLIENT", "PAUSE", String(PAUSE_MS), "ALL");
        const started = Date.now();

        const activation = holder.lazy!.activate("/worker");
        /** A handshake arriving mid-blackout waits on the same activation through the middleware. */
        const socketPromise = connectAndJoin(holder.url, cleanup);

        await withTimeout(
          activation,
          ACTIVATION_TIMEOUT_MS + 2_000,
          "activation never settled after the blackout"
        );
        const elapsed = Date.now() - started;
        /** Proves the pause actually held the subscribe in flight rather than it completing before the pause bit. */
        expect(elapsed).toBeGreaterThan(PAUSE_MS * 0.6);

        const socket = await socketPromise;
        await waitFor(
          async () => (await numsub(control)) === 1,
          "holder subscribed after blackout"
        );
        await expect(expectDelivery(socket, publisher.io, "after-blackout")).resolves.toBe(
          "after-blackout"
        );
        expect(publisher.lazy!.isActivated("/worker")).toBe(false);
      } finally {
        await cleanup.run();
      }
    }
  );

  isolatedRedisTest(
    "[lazy] a process that stayed cold through a node swap activates and delivers afterwards",
    async ({ redisContainer }) => {
      const cleanup = tracker();
      try {
        const control = client(redisContainer, cleanup);
        const holder = await startServer("lazy", redisContainer, cleanup);
        const publisher = await startServer("lazy", redisContainer, cleanup);
        expect(await numsub(control)).toBe(0);

        await nodeSwap(control);
        expect(holder.lazy!.isActivated("/worker")).toBe(false);

        const socket = await connectAndJoin(holder.url, cleanup);
        await waitFor(
          async () => (await numsub(control)) === 1,
          "holder to subscribe after the swap",
          30_000
        );
        await expect(expectDelivery(socket, publisher.io, "cold-then-swap")).resolves.toBe(
          "cold-then-swap"
        );
        expect(publisher.lazy!.isActivated("/worker")).toBe(false);
      } finally {
        await cleanup.run();
      }
    }
  );
});
