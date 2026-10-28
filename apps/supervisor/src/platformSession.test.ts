import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SupervisorSession } from "@trigger.dev/core/v3/runEngineWorker";
import { Server, type Socket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";

describe("the platform session's run subscriptions", () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  async function platform() {
    const http = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/engine/v1/worker-actions/connect") {
        response.end(JSON.stringify({ ok: true, workerGroup: { type: "MANAGED", name: "test" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    const io = new Server(http);
    type Connection = { socket: Socket; subscribed: string[][]; unsubscribed: string[][] };
    const connections: Connection[] = [];
    let rejections = 0;
    let rejectNext = false;
    io.of("/worker").use((_socket, next) => {
      if (rejectNext) {
        rejectNext = false;
        rejections += 1;
        return next(new Error("not ready"));
      }
      next();
    });
    io.of("/worker").on("connection", (socket) => {
      const connection: Connection = { socket, subscribed: [], unsubscribed: [] };
      connections.push(connection);
      socket.on("run:subscribe", ({ runFriendlyIds }) =>
        connection.subscribed.push(runFriendlyIds)
      );
      socket.on("run:unsubscribe", ({ runFriendlyIds }) =>
        connection.unsubscribed.push(runFriendlyIds)
      );
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    cleanups.push(() => io.close());
    return {
      url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      connections,
      /** The next handshake is turned away, as the platform does while its socket adapter is not ready. */
      rejectNextHandshake: () => (rejectNext = true),
      rejections: () => rejections,
    };
  }

  async function until(check: () => boolean, what: string, ms = 10_000) {
    const deadline = performance.now() + ms;
    while (!check() && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(check(), what).toBe(true);
  }

  it("asks for the runs subscribed before the socket existed, and again on every reconnect", async () => {
    const { url, connections, rejectNextHandshake, rejections } = await platform();
    const session = new SupervisorSession({
      apiUrl: url,
      workerToken: "test-token",
      instanceName: "test-worker",
      queueConsumerEnabled: false,
      runNotificationsEnabled: true,
      heartbeatIntervalSeconds: 3600,
      dequeueIntervalMs: 10,
      dequeueIdleIntervalMs: 10,
      scaling: { strategy: "none", minConsumerCount: 1, maxConsumerCount: 1 },
    });
    cleanups.push(() => session.stop());

    session.subscribeToRunNotifications(["run_1", "run_2"]);
    await session.start();
    await until(() => connections[0]?.subscribed.length === 1, "the first connection got no ask");
    expect(connections[0]!.subscribed).toEqual([["run_1", "run_2"]]);

    session.subscribeToRunNotifications(["run_3"]);
    session.unsubscribeFromRunNotifications(["run_2"]);
    await until(() => connections[0]!.unsubscribed.length === 1, "the unsubscribe did not arrive");
    expect(connections[0]!.subscribed).toEqual([["run_1", "run_2"], ["run_3"]]);

    // The platform drops the connection, as a deploy of its socket servers does; the client reconnects.
    connections[0]!.socket.conn.close();
    await until(() => connections.length === 2, "the session did not reconnect");
    await until(() => connections[1]!.subscribed.length === 1, "the reconnect got no ask");
    expect(connections[1]!.subscribed).toEqual([["run_1", "run_3"]]);

    session.unsubscribeFromRunNotifications(["run_1", "run_3"]);
    await until(() => connections[1]!.unsubscribed.length === 1, "the unsubscribe did not arrive");
    connections[1]!.socket.conn.close();
    await until(() => connections.length === 3, "the session did not reconnect again");
    // Asks arrive in order, so a later one proves nothing was asked for the empty set on connect.
    session.subscribeToRunNotifications(["run_4"]);
    await until(() => connections[2]!.subscribed.length > 0, "the later ask did not arrive");
    expect(connections[2]!.subscribed).toEqual([["run_4"]]);

    // The platform turns the reconnect away, which socket.io takes as final; the client is down for sure
    // once the rejection went out. What changes meanwhile reaches the next connection as one ask.
    rejectNextHandshake();
    connections[2]!.socket.conn.close();
    await until(() => rejections() === 1, "the handshake was not turned away");
    session.subscribeToRunNotifications(["run_5"]);
    session.unsubscribeFromRunNotifications(["run_4"]);
    await until(
      () => connections.length === 4,
      "the session did not connect again after the rejection"
    );
    await until(
      () => connections[3]!.subscribed.length === 1,
      "the connection after the rejection got no ask"
    );
    expect(connections[3]!.subscribed).toEqual([["run_5"]]);
    expect(connections[3]!.unsubscribed).toEqual([]);

    // Disconnected by the platform itself, which socket.io takes as final too.
    connections[3]!.socket.disconnect();
    await until(
      () => connections.length === 5,
      "the session did not connect again after being disconnected"
    );
    await until(
      () => connections[4]!.subscribed.length === 1,
      "the connection after the disconnect got no ask"
    );
    expect(connections[4]!.subscribed).toEqual([["run_5"]]);
  }, 20_000);
});
