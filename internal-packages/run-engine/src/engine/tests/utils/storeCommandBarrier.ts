import net from "node:net";
import type { RedisOptions } from "@internal/redis";

/** Delay one real Redis request without changing its command, reply, or server-side implementation. */
export async function storeCommandBarrier(redisOptions: RedisOptions) {
  const sockets = new Set<net.Socket>();
  let blocked: (() => void) | undefined;
  let held: { data: Buffer; upstream: net.Socket } | undefined;
  const server = net.createServer((downstream) => {
    const upstream = net.connect(redisOptions.port!, redisOptions.host!);
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("data", (data) => {
      if (held) {
        held.data = Buffer.concat([held.data, data]);
      } else if (blocked) {
        held = { data, upstream };
        const notify = blocked;
        blocked = undefined;
        notify();
      } else {
        upstream.write(data);
      }
    });
    upstream.pipe(downstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => {
      upstream.destroy();
      sockets.delete(upstream);
      sockets.delete(downstream);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  return {
    redisOptions: { ...redisOptions, host: "127.0.0.1", port: address.port, commandTimeout: 5_000 },
    pauseNextRequest() {
      return new Promise<void>((resolve) => {
        blocked = resolve;
      });
    },
    request() {
      return held?.data.toString("utf8") ?? "";
    },
    release() {
      if (!held) return;
      held.upstream.write(held.data);
      held = undefined;
    },
    async close() {
      blocked = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
