import net from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { formatConsoleLine, formatLogLine, stripAnsi, TelnetLogServer } from "./telnetLogServer.js";

const servers: TelnetLogServer[] = [];

afterEach(() => {
  while (servers.length) {
    servers.pop()?.close();
  }
});

/** Grab a port the OS just told us is free, then hand it to a TelnetLogServer. */
async function startServerOnFreePort(
  name = "test"
): Promise<{ server: TelnetLogServer; port: number }> {
  const probe = net.createServer();
  const port = await listening(probe, 0);
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  // A banner lets clients deterministically wait until the server has registered them
  // (it's written in the connection handler), removing the connect/register race.
  const server = new TelnetLogServer({ port, name, banner: "ready" });
  servers.push(server);
  server.start();
  await delay(30);
  return { server, port };
}

/** Connects and resolves only once the first bytes (the banner) arrive — server-side socket is registered by then. */
function connectAndCollect(port: number): Promise<{ socket: net.Socket; lines: () => string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const socket = net.connect(port, "127.0.0.1");
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const first = buffer === "";
      buffer += chunk;
      if (first) {
        resolve({ socket, lines: () => buffer });
      }
    });
    socket.on("error", reject);
  });
}

function listening(server: net.Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

describe("stripAnsi", () => {
  test("removes color escape codes", () => {
    const colored = "[90m2026-06-11[39m [31mERROR[39m boom";
    expect(stripAnsi(colored)).toBe("2026-06-11 ERROR boom");
  });
});

describe("formatLogLine", () => {
  test("formats a core Logger-shaped object (level/name)", () => {
    const line = formatLogLine({
      timestamp: new Date("2026-06-11T12:00:00.000Z"),
      name: "webapp",
      level: "info",
      message: "queue drained",
      count: 3,
    });
    expect(line).toBe("2026-06-11T12:00:00.000Z INFO  [webapp] queue drained {count=3}");
  });

  test("formats a SimpleStructuredLogger-shaped object ($level/$name)", () => {
    const line = formatLogLine({
      timestamp: new Date("2026-06-11T12:00:00.000Z"),
      $name: "supervisor",
      $level: "warn",
      message: "retrying",
      attempt: 2,
    });
    expect(line).toBe("2026-06-11T12:00:00.000Z WARN  [supervisor] retrying {attempt=2}");
  });

  test("omits empty name and extras", () => {
    const line = formatLogLine({
      timestamp: "2026-06-11T12:00:00.000Z",
      level: "log",
      message: "hello",
    });
    expect(line).toBe("2026-06-11T12:00:00.000Z LOG   hello");
  });
});

describe("formatConsoleLine", () => {
  test("pretty-formats a JSON structured-log line", () => {
    const raw = JSON.stringify({
      timestamp: "2026-06-11T12:00:00.000Z",
      name: "sso-plugin",
      level: "info",
      message: "sso.webhook.connection.activated: connection marked active",
      connId: "conn_123",
    });
    expect(formatConsoleLine(raw)).toBe(
      "2026-06-11T12:00:00.000Z INFO  [sso-plugin] sso.webhook.connection.activated: connection marked active {connId=conn_123}"
    );
  });

  test("passes non-JSON console output through unchanged", () => {
    expect(formatConsoleLine("GET /healthcheck 200 1.2 ms")).toBe("GET /healthcheck 200 1.2 ms");
  });

  test("passes JSON that isn't a structured log through unchanged", () => {
    const raw = JSON.stringify({ foo: "bar" });
    expect(formatConsoleLine(raw)).toBe(raw);
  });
});

describe("TelnetLogServer", () => {
  test("broadcasts a line to a connected client", async () => {
    const { server, port } = await startServerOnFreePort();
    const client = await connectAndCollect(port);
    server.broadcast("first line");
    await delay(50);
    expect(client.lines()).toContain("first line\r\n");
    client.socket.destroy();
  });

  test("close() ends connected sockets", async () => {
    const { server, port } = await startServerOnFreePort();
    const client = await connectAndCollect(port);
    server.broadcast("alive");
    await delay(30);
    expect(client.lines()).toContain("alive\r\n");

    let closed = false;
    client.socket.on("close", () => {
      closed = true;
    });
    server.close();
    await delay(30);
    expect(closed).toBe(true);
  });

  test("EADDRINUSE does not throw", async () => {
    const blocker = net.createServer();
    const port = await listening(blocker, 0);

    const server = new TelnetLogServer({ port, name: "test" });
    servers.push(server);
    // Must not throw even though the port is taken.
    expect(() => server.start()).not.toThrow();
    await delay(30);

    blocker.close();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
