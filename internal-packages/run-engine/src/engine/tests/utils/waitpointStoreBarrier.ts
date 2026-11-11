import net from "node:net";
import type { RedisOptions } from "@internal/redis";

/** Hold an actual Redis request (or its reply) at a selected durable protocol boundary. */
export async function waitpointStoreBarrier(redisOptions: RedisOptions) {
  const sockets = new Set<net.Socket>();
  let match: ((args: string[]) => boolean) | undefined;
  let notify: (() => void) | undefined;
  let replyMode = false;
  let selected: string[] | undefined;
  let release: (() => void) | undefined;
  const server = net.createServer((downstream) => {
    const upstream = net.connect(redisOptions.port!, redisOptions.host!);
    sockets.add(downstream);
    sockets.add(upstream);
    let pending: Buffer = Buffer.alloc(0);
    let waitingReply = false;
    let heldReply: Buffer = Buffer.alloc(0);
    let heldRequest: Buffer = Buffer.alloc(0);
    downstream.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length) {
        // Redis clients send arrays of bulk strings. Keep the original wire bytes intact.
        const header = pending.indexOf("\r\n");
        if (header < 0) return;
        const count = Number(pending.subarray(1, header).toString());
        let offset = header + 2;
        const args: string[] = [];
        for (let index = 0; index < count; index++) {
          const end = pending.indexOf("\r\n", offset);
          if (end < 0) return;
          const length = Number(pending.subarray(offset + 1, end).toString());
          offset = end + 2;
          if (pending.length < offset + length + 2) return;
          args.push(pending.subarray(offset, offset + length).toString());
          offset += length + 2;
        }
        const request = pending.subarray(0, offset);
        pending = pending.subarray(offset);
        if (heldRequest.length) {
          heldRequest = Buffer.concat([heldRequest, request]);
        } else if (match?.(args)) {
          match = undefined;
          selected = args;
          if (replyMode) {
            waitingReply = true;
            upstream.write(request);
          } else {
            heldRequest = Buffer.from(request);
            release = () => {
              upstream.write(heldRequest);
              heldRequest = Buffer.alloc(0);
            };
            notify?.();
          }
        } else {
          upstream.write(request);
        }
      }
    });
    upstream.on("data", (data) => {
      if (waitingReply) {
        heldReply = Buffer.concat([heldReply, data]);
        release = () => {
          downstream.write(heldReply);
          heldReply = Buffer.alloc(0);
          waitingReply = false;
        };
        notify?.();
      } else downstream.write(data);
    });
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
    redisOptions: { ...redisOptions, host: "127.0.0.1", port: address.port, commandTimeout: 5000 },
    pause(predicate: (args: string[]) => boolean, mode: "request" | "reply" = "request") {
      release = undefined;
      replyMode = mode === "reply";
      match = predicate;
      return new Promise<void>((resolve) => {
        notify = resolve;
      });
    },
    get requestArgs() {
      return selected;
    },
    get held() {
      return release !== undefined;
    },
    release() {
      release?.();
      release = undefined;
    },
    disconnect() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
