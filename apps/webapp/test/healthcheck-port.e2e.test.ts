/**
 * E2E for HEALTHCHECK_PORT: the dedicated listener runs the same readiness
 * checks as /healthcheck on the main port and serves nothing else.
 *
 * Requires a pre-built webapp: pnpm run build --filter webapp
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestServer } from "@internal/testcontainers/webapp";
import { findFreePort, startTestServer } from "@internal/testcontainers/webapp";

const LINKED_PLUGIN_PATH = resolve(__dirname, "..", "node_modules", "@triggerdotdev", "plugins");
const pluginLocallyLinked = existsSync(LINKED_PLUGIN_PATH);

vi.setConfig({ testTimeout: 180_000 });

async function startWithHealthPort(options: { requirePlugins?: boolean } = {}) {
  const healthPort = await findFreePort();
  const server = await startTestServer({
    ...options,
    extraEnv: { HEALTHCHECK_PORT: String(healthPort) },
  });
  const fetchHealthPort = (path: string) => fetch(`http://localhost:${healthPort}${path}`);
  return { server, fetchHealthPort, healthPort };
}

function rawGet(port: number, path: string, host: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("end", () => resolvePromise(response.split("\r\n")[0]));
    socket.on("error", reject);
  });
}

describe("HEALTHCHECK_PORT", () => {
  describe("ready webapp", () => {
    let server: TestServer;
    let fetchHealthPort: (path: string) => Promise<Response>;
    let healthPort: number;

    beforeAll(async () => {
      ({ server, fetchHealthPort, healthPort } = await startWithHealthPort());
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
    }, 120_000);

    it("serves /healthcheck on the health port", async () => {
      const res = await fetchHealthPort("/healthcheck");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    });

    it("does not serve app routes on the health port", async () => {
      for (const path of ["/", "/api/v1/runs", "/login"]) {
        const res = await fetchHealthPort(path);
        expect(res.status, path).toBe(404);
      }
    });

    it("rejects a Host header that would reroute /healthcheck to another loader", async () => {
      // fetch() can't send this Host, so use a raw socket.
      const statusLine = await rawGet(healthPort, "/healthcheck", "x\\api\\v1\\runs?a=");
      expect(statusLine).toBe("HTTP/1.1 400 Bad Request");
    });
  });

  describe.skipIf(pluginLocallyLinked)("REQUIRE_PLUGINS=1 + plugin missing", () => {
    let server: TestServer;
    let fetchHealthPort: (path: string) => Promise<Response>;

    beforeAll(async () => {
      ({ server, fetchHealthPort } = await startWithHealthPort({ requirePlugins: true }));
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
    }, 120_000);

    it("returns 500 on the health port, same as the main port", async () => {
      const res = await fetchHealthPort("/healthcheck");
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("ERROR");
    });
  });
});
