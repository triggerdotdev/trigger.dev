/**
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestServer } from "@internal/testcontainers/webapp";
import { startTestServer } from "@internal/testcontainers/webapp";
import { connect } from "node:net";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";

vi.setConfig({ testTimeout: 60_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

type UpgradeResult = { statusLine: string | null };

// Sends a raw websocket upgrade request, optionally followed by extra bytes once
// the server answers, and resolves with the response status line (null when the
// server closes the socket without answering).
function sendUpgrade(
  path: string,
  options: { headers?: Record<string, string>; followUp?: Buffer } = {}
): Promise<UpgradeResult> {
  const { port, hostname } = new URL(server.webapp.baseUrl);

  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let response = "";

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`upgrade to ${path} neither answered nor closed within 10s`));
    }, 10_000);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const statusLine = response.split("\r\n")[0] || null;
      resolve({ statusLine });
    };

    socket.on("connect", () => {
      const headers = {
        Host: `${hostname}:${port}`,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        ...options.headers,
      };
      const head = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      socket.write(`GET ${path} HTTP/1.1\r\n${head}\r\n\r\n`);
    });

    socket.on("data", (chunk) => {
      const first = response.length === 0;
      response += chunk.toString("latin1");
      if (first && options.followUp) {
        socket.write(options.followUp);
        // Give the server a moment to act on the extra bytes before we hang up.
        setTimeout(finish, 200);
        return;
      }
      finish();
    });

    socket.on("close", finish);
    socket.on("error", () => {});
  });
}

async function expectServerHealthy() {
  const res = await server.webapp.fetch("/healthcheck");
  expect(res.status, "webapp stopped serving after the invalid frame").toBe(200);
}

describe("websocket upgrades", () => {
  // Catches: the retired v3 dev path still being upgraded to a websocket.
  it("refuses an upgrade to /ws without credentials", async () => {
    const { statusLine } = await sendUpgrade("/ws");
    expect(statusLine ?? "").not.toContain("101");
  });

  // Catches: a valid API key still opening a websocket on the retired v3 dev path.
  it("refuses an upgrade to /ws with a valid API key", async () => {
    const { apiKey } = await seedTestEnvironment(server.prisma);
    const { statusLine } = await sendUpgrade("/ws", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(statusLine ?? "").not.toContain("101");
  });

  it("refuses an upgrade to an unknown path", async () => {
    const { statusLine } = await sendUpgrade("/not-a-socket");
    expect(statusLine ?? "").not.toContain("101");
  });

  // Catches: tightening the upgrade handler cutting off socket.io clients.
  it("still upgrades socket.io websocket connections", async () => {
    const { statusLine } = await sendUpgrade("/socket.io/?EIO=4&transport=websocket");
    expect(statusLine).toContain("101");
  });

  // Catches: an invalid frame on an upgraded socket.io connection taking the server down.
  it("keeps serving after an invalid frame on a socket.io websocket", async () => {
    const { statusLine } = await sendUpgrade("/socket.io/?EIO=4&transport=websocket", {
      followUp: Buffer.from([0xf1, 0x80, 0, 0, 0, 0]),
    });
    expect(statusLine, "socket.io upgrade was not accepted, so the frame was never sent").toContain(
      "101"
    );
    await expectServerHealthy();
  });
});
