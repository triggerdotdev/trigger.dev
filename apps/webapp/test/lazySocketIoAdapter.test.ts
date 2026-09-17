import { redisTest } from "@internal/testcontainers";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis, type RedisOptions } from "ioredis";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { Server } from "socket.io";
import { describe, expect } from "vitest";
import {
  createLazySocketIoAdapter,
  RESPONSE_DEPENDENT_METHODS,
  withTimeout,
} from "~/v3/lazySocketIoAdapter.server";

const KEY = "tr:socket.io:";
const ADAPTER_OPTS = { key: KEY, publishOnSpecificResponseChannel: true } as const;
const WORKER_REQUEST_CHANNEL = `${KEY}-request#/worker#`;
const DEV_WORKER_REQUEST_CHANNEL = `${KEY}-request#/dev-worker#`;

type Cleanup = () => Promise<void> | void;

function tracker() {
  const cleanups: Cleanup[] = [];
  let done = false;
  return {
    add: (fn: Cleanup) => cleanups.push(fn),
    async run() {
      if (done) {
        return;
      }
      done = true;
      for (const fn of cleanups.reverse()) {
        await fn();
      }
    },
  };
}

/** ioredis surfaces post-disconnect socket errors as unhandled rejections; absorb them. */
function createRedis(options: RedisOptions, cleanup: ReturnType<typeof tracker>): Redis {
  const client = new Redis(options);
  client.on("error", () => {});
  cleanup.add(() => client.disconnect());
  return client;
}

async function numsub(inspector: Redis, channel: string): Promise<number> {
  const result = (await inspector.pubsub("NUMSUB", channel)) as [string, number];
  return Number(result[1]);
}

/**
 * Per-adapter response channels for /worker. Each adapter instance owns one,
 * keyed by its uid, so this counts adapter instances that have flushed even
 * when they share a single Redis connection (NUMSUB counts connections, not
 * subscribe calls, so it cannot tell two adapters on one client apart).
 */
async function workerInstanceChannels(inspector: Redis): Promise<number> {
  const channels = (await inspector.pubsub("CHANNELS", `${KEY}-response#/worker#*`)) as string[];
  return channels.filter((c) => c !== `${KEY}-response#/worker#`).length;
}

async function numpat(inspector: Redis): Promise<number> {
  return Number(await inspector.pubsub("NUMPAT"));
}

/**
 * The /worker channels with the adapter's per-instance uid masked, so two
 * adapter instances can be compared for shape.
 */
async function workerChannels(inspector: Redis): Promise<string[]> {
  const channels = (await inspector.pubsub("CHANNELS", `${KEY}*`)) as string[];
  return channels
    .filter((c) => c.includes("#/worker#"))
    .map((c) => c.replace(/(#\/worker#)[^#]+#$/, "$1<uid>#"))
    .sort();
}

/**
 * Waits for a Redis-visible condition. Subscriptions are issued over a
 * separate connection, so they are not necessarily visible the instant an
 * await resolves.
 */
async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

/**
 * A socket.io server wired the way the webapp wires it: lazy adapter, plus a
 * middleware that opens the namespace's subscriptions before the handshake
 * completes.
 */
async function startLazyServer(redisOptions: RedisOptions, cleanup: ReturnType<typeof tracker>) {
  const pubClient = new Redis(redisOptions);
  const subClient = pubClient.duplicate();
  pubClient.on("error", () => {});
  subClient.on("error", () => {});
  const lazy = createLazySocketIoAdapter(pubClient, subClient, { ...ADAPTER_OPTS });

  const io = new Server({ adapter: lazy.adapter });

  for (const namespace of ["/worker", "/dev-worker"]) {
    io.of(namespace).use(async (_socket, next) => {
      try {
        await lazy.activate(namespace);
        next();
      } catch (error) {
        next(error instanceof Error ? error : new Error("activate failed"));
      }
    });
  }

  const httpServer: HttpServer = createServer();
  io.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  cleanup.add(async () => {
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    /**
     * Stop receiving before losing the ability to respond. A request that
     * arrives on subClient makes the adapter publishResponse on pubClient
     * without awaiting it, so quitting pub first (or concurrently) can reject
     * that publish with "Connection is closed". close() also fires
     * punsubscribe/unsubscribe unawaited, and enableAutoPipelining defers
     * commands a tick, so let each side flush before the next step.
     */
    await new Promise((resolve) => setImmediate(resolve));
    await subClient.quit().catch(() => {});
    /**
     * A publish enqueued via enableAutoPipelining is sent on a later
     * setImmediate; quitting before that flush rejects it with "Connection is
     * closed". PING joins the same pipeline behind any pending publish, so
     * once it answers, those publishes have been sent.
     */
    await pubClient.ping().catch(() => {});
    await pubClient.quit().catch(() => {});
  });

  return { io, lazy, port, url: `http://localhost:${port}` };
}

async function connectClient(
  url: string,
  namespace: string,
  cleanup: ReturnType<typeof tracker>
): Promise<ClientSocket> {
  const socket = ioClient(`${url}${namespace}`, { transports: ["websocket"] });
  cleanup.add(() => {
    socket.disconnect();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

describe("lazy socket.io redis adapter", () => {
  redisTest(
    "does not subscribe until a namespace serves a connection",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const server = await startLazyServer(redisOptions, cleanup);

        expect(await numpat(inspector)).toBe(0);
        expect(await numsub(inspector, WORKER_REQUEST_CHANNEL)).toBe(0);

        await connectClient(server.url, "/worker", cleanup);

        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "worker request channel to gain a subscriber"
        );
        expect(await numpat(inspector)).toBe(1);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "a connection on one namespace does not subscribe the other",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const server = await startLazyServer(redisOptions, cleanup);
        await connectClient(server.url, "/worker", cleanup);

        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "worker namespace to activate"
        );

        expect(await numsub(inspector, DEV_WORKER_REQUEST_CHANNEL)).toBe(0);
        expect(server.lazy.isActivated("/dev-worker")).toBe(false);
        expect(server.lazy.activatedNamespaces()).toEqual(["/worker"]);

        await connectClient(server.url, "/dev-worker", cleanup);

        await waitFor(
          async () => (await numsub(inspector, DEV_WORKER_REQUEST_CHANNEL)) === 1,
          "dev-worker namespace to activate"
        );
        expect(await numpat(inspector)).toBe(2);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "an activated namespace subscribes exactly what the stock adapter does",
    async ({ redisOptions }) => {
      const eagerCleanup = tracker();
      const inspector = createRedis(redisOptions, eagerCleanup);

      let eagerChannels: string[] = [];
      let eagerPatterns = 0;

      try {
        const eagerPub = new Redis(redisOptions);
        const eagerSub = eagerPub.duplicate();
        eagerPub.on("error", () => {});
        eagerSub.on("error", () => {});
        eagerCleanup.add(() => {
          eagerPub.disconnect();
          eagerSub.disconnect();
        });

        const eagerIo = new Server({
          adapter: createAdapter(eagerPub, eagerSub, { ...ADAPTER_OPTS }),
        });
        eagerIo.of("/worker");

        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "stock adapter to subscribe"
        );

        eagerChannels = await workerChannels(inspector);
        eagerPatterns = await numpat(inspector);
      } finally {
        await eagerCleanup.run();
      }

      const lazyCleanup = tracker();
      const inspector2 = createRedis(redisOptions, lazyCleanup);

      try {
        await waitFor(
          async () => (await numsub(inspector2, WORKER_REQUEST_CHANNEL)) === 0,
          "stock adapter subscriptions to drain"
        );

        const server = await startLazyServer(redisOptions, lazyCleanup);
        await connectClient(server.url, "/worker", lazyCleanup);

        await waitFor(
          async () => (await numsub(inspector2, WORKER_REQUEST_CHANNEL)) === 1,
          "lazy adapter to subscribe after connection"
        );

        const lazyChannels = await workerChannels(inspector2);

        expect(eagerChannels).toEqual([
          `${KEY}-request#/worker#`,
          `${KEY}-response#/worker#`,
          `${KEY}-response#/worker#<uid>#`,
        ]);
        expect(lazyChannels).toEqual(eagerChannels);

        /** The stock adapter also subscribes the unused default namespace; the lazy one does not. */
        expect(eagerPatterns).toBe(2);
        expect(await numpat(inspector2)).toBe(1);
      } finally {
        await lazyCleanup.run();
      }
    }
  );

  redisTest(
    "a process with no connections receives nothing, and delivery still works",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const holder = await startLazyServer(redisOptions, cleanup);
        const publisher = await startLazyServer(redisOptions, cleanup);

        const client = await connectClient(holder.url, "/worker", cleanup);

        const room = "room:run_test";
        holder.io.of("/worker").sockets.get(client.id!)?.join(room);

        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "only the holder to be subscribed"
        );

        expect(publisher.lazy.isActivated("/worker")).toBe(false);
        expect(await numsub(inspector, WORKER_REQUEST_CHANNEL)).toBe(1);
        expect(await numpat(inspector)).toBe(1);

        const received = new Promise<{ friendlyId: string }>((resolve) => {
          client.on("run:notify", (payload: { run: { friendlyId: string } }) =>
            resolve(payload.run)
          );
        });

        publisher.io
          .of("/worker")
          .to(room)
          .emit("run:notify", { version: "1", run: { friendlyId: "run_test" } });

        await expect(received).resolves.toEqual({ friendlyId: "run_test" });

        expect(publisher.lazy.isActivated("/worker")).toBe(false);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "a distributed query from a publisher with no connections still sees remote sockets",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const holder = await startLazyServer(redisOptions, cleanup);
        const publisher = await startLazyServer(redisOptions, cleanup);

        await connectClient(holder.url, "/worker", cleanup);

        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "only the holder to be subscribed"
        );
        expect(publisher.lazy.isActivated("/worker")).toBe(false);

        /**
         * fetchSockets sizes its wait from NUMSUB on the request channel and
         * assumes the caller is one of them, so an unsubscribed caller would
         * see numSub === 1, take it for itself and return only local sockets.
         */
        const sockets = await publisher.io.of("/worker").fetchSockets();

        expect(sockets).toHaveLength(1);
        expect(publisher.lazy.isActivated("/worker")).toBe(true);
        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 2,
          "the querying process to have subscribed"
        );
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "a server-side emit with ack from a publisher with no connections reaches peers",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const holder = await startLazyServer(redisOptions, cleanup);
        const publisher = await startLazyServer(redisOptions, cleanup);

        await connectClient(holder.url, "/worker", cleanup);
        holder.io.of("/worker").on("ping-peers", (ack: (value: string) => void) => ack("pong"));

        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "only the holder to be subscribed"
        );
        expect(publisher.lazy.isActivated("/worker")).toBe(false);

        const responses = await publisher.io.of("/worker").serverSideEmitWithAck("ping-peers");

        expect(responses).toEqual(["pong"]);
        expect(publisher.lazy.isActivated("/worker")).toBe(true);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "every response-dependent adapter method still exists to be wrapped",
    async ({ redisOptions }) => {
      const cleanup = tracker();

      try {
        const server = await startLazyServer(redisOptions, cleanup);
        const adapter = server.io.of("/worker").adapter as unknown as Record<string, unknown>;

        /**
         * The wrapper skips silently when a method is missing, so an upstream
         * rename would drop the RPC protection without any other test noticing.
         */
        for (const method of Object.keys(RESPONSE_DEPENDENT_METHODS)) {
          expect(typeof adapter[method], method).toBe("function");
        }
        /** Unwrapped, but the ack path of serverSideEmit relies on it reaching the wrapped emitWithAck. */
        expect(typeof adapter.serverSideEmit).toBe("function");
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "a namespace recreated under the same name activates like new",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const server = await startLazyServer(redisOptions, cleanup);
        await server.lazy.activate("/worker");
        await waitFor(
          async () => (await workerInstanceChannels(inspector)) === 1,
          "first adapter to subscribe"
        );

        /**
         * Drop and rebuild the namespace so socket.io constructs a second
         * adapter for the same name. A stale activation record would make the
         * new adapter report itself subscribed while its queue never flushed.
         */
        (server.io as unknown as { _nsps: Map<string, unknown> })._nsps.delete("/worker");
        server.io.of("/worker");

        expect(server.lazy.isActivated("/worker")).toBe(false);

        await server.lazy.activate("/worker");

        expect(server.lazy.isActivated("/worker")).toBe(true);
        await waitFor(
          async () => (await workerInstanceChannels(inspector)) === 2,
          "the recreated adapter to subscribe alongside the first"
        );
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "sync adapter operations return synchronously once the namespace is active",
    async ({ redisOptions }) => {
      const cleanup = tracker();

      try {
        const server = await startLazyServer(redisOptions, cleanup);
        const adapter = server.io.of("/worker").adapter as unknown as {
          broadcastWithAck: (...args: unknown[]) => unknown;
        };
        const args = [
          { type: 2, data: ["noop"] },
          { rooms: new Set<string>(), except: new Set<string>(), flags: { timeout: 60_000 } },
          () => {},
          () => {},
        ];

        const cold = adapter.broadcastWithAck(...args);
        expect(cold).toBeInstanceOf(Promise);
        await cold;

        /**
         * broadcastWithAck returns void in the stock adapter; a Promise here
         * would mean the publish was deferred a tick and could reorder against
         * a plain broadcast issued right after it.
         */
        const warm = adapter.broadcastWithAck(...args);
        expect(warm).toBeUndefined();
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest("withTimeout bounds a stalled activation but passes fast ones through", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "slow")).resolves.toBe("ok");
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "slow")).rejects.toThrow(
      "boom"
    );
    await expect(withTimeout(new Promise<never>(() => {}), 20, "stalled")).rejects.toThrow(
      "stalled"
    );
  });

  redisTest(
    "a fire-and-forget server-side emit reaches peers without subscribing the sender",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const holder = await startLazyServer(redisOptions, cleanup);
        const publisher = await startLazyServer(redisOptions, cleanup);

        await connectClient(holder.url, "/worker", cleanup);
        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "holder to subscribe"
        );

        const received = new Promise<string>((resolve) =>
          holder.io.of("/worker").on("fire", (value: string) => resolve(value))
        );

        /** No ack means no requestId on the wire, so peers never reply and the sender needs no subscription. */
        publisher.io.of("/worker").serverSideEmit("fire", "payload");

        await expect(received).resolves.toBe("payload");
        expect(publisher.lazy.isActivated("/worker")).toBe(false);
        expect(await numsub(inspector, WORKER_REQUEST_CHANNEL)).toBe(1);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "local-only fetchSockets and broadcastWithAck leave an idle process unsubscribed",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const server = await startLazyServer(redisOptions, cleanup);
        const nsp = server.io.of("/worker");

        const local = await nsp.local.fetchSockets();
        expect(local).toEqual([]);

        const adapter = nsp.adapter as unknown as {
          broadcastWithAck: (...args: unknown[]) => unknown;
        };
        const result = adapter.broadcastWithAck(
          { type: 2, data: ["noop"] },
          { rooms: new Set<string>(), except: new Set<string>(), flags: { local: true } },
          () => {},
          () => {}
        );

        /** Synchronous on the cold path too, because a local call never activates. */
        expect(result).toBeUndefined();
        expect(server.lazy.isActivated("/worker")).toBe(false);
        expect(await numpat(inspector)).toBe(0);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "an activation still in flight when its namespace is rebuilt cannot mark the replacement ready",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const pubClient = new Redis(redisOptions);
        /**
         * Not yet connected. The first queued psubscribe triggers ioredis's
         * auto-connect, so the first adapter's flush is in flight from the
         * moment activate() is called and cannot settle before the synchronous
         * reconstruction below: a socket connect is at least a macrotask away.
         */
        const subClient = new Redis({ ...redisOptions, lazyConnect: true });
        pubClient.on("error", () => {});
        subClient.on("error", () => {});
        cleanup.add(async () => {
          /** Sub before pub, so an in-flight response still has a client to publish on. */
          await subClient.quit().catch(() => {});
          await pubClient.ping().catch(() => {});
          await pubClient.quit().catch(() => {});
        });

        const lazy = createLazySocketIoAdapter(pubClient, subClient, { ...ADAPTER_OPTS });
        const io = new Server({ adapter: lazy.adapter });
        const first = io.of("/worker");
        const firstActivation = lazy.activate("/worker");
        expect(lazy.isActivated("/worker")).toBe(true);
        expect(subClient.status).not.toBe("ready");

        /** Rebuild under the same name while the first activation is still waiting on the connection. */
        (io as unknown as { _nsps: Map<string, unknown> })._nsps.delete("/worker");
        const second = io.of("/worker");
        expect(second).not.toBe(first);
        expect(lazy.isActivated("/worker")).toBe(false);

        await firstActivation;

        /**
         * The first adapter's completion must have settled into its own state.
         * The replacement is still cold: a reply-needing call takes the async
         * path rather than the ready fast path, and its own response channel
         * has not appeared.
         */
        expect(lazy.isActivated("/worker")).toBe(false);
        const replacement = second.adapter as unknown as {
          broadcastWithAck: (...args: unknown[]) => unknown;
        };
        const cold = replacement.broadcastWithAck(
          { type: 2, data: ["noop"] },
          { rooms: new Set<string>(), except: new Set<string>(), flags: { timeout: 60_000 } },
          () => {},
          () => {}
        );
        expect(cold).toBeInstanceOf(Promise);
        await cold;

        expect(lazy.isActivated("/worker")).toBe(true);
        await waitFor(
          async () => (await workerInstanceChannels(inspector)) === 2,
          "both adapter generations to hold their own response channel"
        );
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "serverCount keeps counting the caller on a cold namespace without subscribing it",
    async ({ redisOptions }) => {
      const cleanup = tracker();
      const inspector = createRedis(redisOptions, cleanup);

      try {
        const lone = await startLazyServer(redisOptions, cleanup);
        const loneNsp = lone.io.of("/worker");

        /** Stock adapter on a lone process returns 1: itself. The cold lazy adapter must agree. */
        await expect(loneNsp.adapter.serverCount()).resolves.toBe(1);
        expect(lone.lazy.isActivated("/worker")).toBe(false);
        expect(await numsub(inspector, WORKER_REQUEST_CHANNEL)).toBe(0);

        const peer = await startLazyServer(redisOptions, cleanup);
        await connectClient(peer.url, "/worker", cleanup);
        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
          "peer to subscribe"
        );

        /** One subscribed peer plus the cold caller itself. */
        await expect(loneNsp.adapter.serverCount()).resolves.toBe(2);
        expect(lone.lazy.isActivated("/worker")).toBe(false);

        /** Once subscribed, NUMSUB already includes this process; no double counting. */
        await lone.lazy.activate("/worker");
        await waitFor(
          async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 2,
          "caller to subscribe"
        );
        await expect(loneNsp.adapter.serverCount()).resolves.toBe(2);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest(
    "serverCount does not double count when activation lands during its cold read",
    async ({ redisOptions }) => {
      const cleanup = tracker();

      try {
        /**
         * Force the interleaving the bots described. The pub client is not yet
         * connected, so the cold NUMSUB queues behind a TCP connect and
         * handshake, while the sub client is already connected and a
         * synchronously started activate() subscribes in a single round trip.
         * The subscription therefore reaches Redis before NUMSUB executes, and
         * NUMSUB already includes this process.
         */
        const pubClient = new Redis({ ...redisOptions, lazyConnect: true });
        const subClient = new Redis(redisOptions);
        pubClient.on("error", () => {});
        subClient.on("error", () => {});
        cleanup.add(async () => {
          await subClient.quit().catch(() => {});
          await pubClient.ping().catch(() => {});
          await pubClient.quit().catch(() => {});
        });
        /**
         * A real round trip, not a status poll: clients built from the fixture
         * options sit in "wait" until their first command, so polling status
         * without issuing one would never see "ready".
         */
        await subClient.ping();
        expect(subClient.status).toBe("ready");

        const lazy = createLazySocketIoAdapter(pubClient, subClient, { ...ADAPTER_OPTS });
        const io = new Server({ adapter: lazy.adapter });
        const nsp = io.of("/worker");

        expect(pubClient.status).not.toBe("ready");
        const counting = nsp.adapter.serverCount();
        expect(lazy.isActivated("/worker")).toBe(false);
        const activating = lazy.activate("/worker");

        /** A lone process is exactly one server, cold or subscribed; never two. */
        await expect(counting).resolves.toBe(1);
        await activating;
        await expect(nsp.adapter.serverCount()).resolves.toBe(1);
      } finally {
        await cleanup.run();
      }
    }
  );

  redisTest("activation is idempotent across concurrent connections", async ({ redisOptions }) => {
    const cleanup = tracker();
    const inspector = createRedis(redisOptions, cleanup);

    try {
      const server = await startLazyServer(redisOptions, cleanup);

      await Promise.all([
        connectClient(server.url, "/worker", cleanup),
        connectClient(server.url, "/worker", cleanup),
        connectClient(server.url, "/worker", cleanup),
      ]);

      await waitFor(
        async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
        "worker namespace to activate"
      );

      expect(await numsub(inspector, WORKER_REQUEST_CHANNEL)).toBe(1);
      expect(await numpat(inspector)).toBe(1);
      expect(server.lazy.activatedNamespaces()).toEqual(["/worker"]);
    } finally {
      await cleanup.run();
    }
  });

  redisTest("a failed activation is retried rather than cached", async ({ redisOptions }) => {
    const cleanup = tracker();
    const inspector = createRedis(redisOptions, cleanup);

    try {
      const pubClient = new Redis(redisOptions);
      pubClient.on("error", () => {});
      /** Offline and refusing to queue, so the first subscribe rejects for real. */
      const subClient = new Redis({
        ...redisOptions,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      cleanup.add(() => {
        pubClient.disconnect();
        subClient.disconnect();
      });

      /** Connection failures here are expected; keep them off the unhandled path. */
      subClient.on("error", () => {});

      const lazy = createLazySocketIoAdapter(pubClient, subClient, { ...ADAPTER_OPTS });
      const io = new Server({ adapter: lazy.adapter });
      io.of("/worker");

      await expect(lazy.activate("/worker")).rejects.toThrow();
      expect(lazy.isActivated("/worker")).toBe(false);
      expect(await numsub(inspector, WORKER_REQUEST_CHANNEL)).toBe(0);

      /** The rejected command already kicked off a connect; wait for it to settle. */
      await waitFor(async () => subClient.status === "ready", "subClient to reconnect");
      await lazy.activate("/worker");

      await waitFor(
        async () => (await numsub(inspector, WORKER_REQUEST_CHANNEL)) === 1,
        "retry to complete the full subscription set"
      );
      expect(await numpat(inspector)).toBe(1);
    } finally {
      await cleanup.run();
    }
  });
});
