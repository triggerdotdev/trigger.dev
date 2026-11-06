import { createRemixRequest } from "@remix-run/express/dist/server.js";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostHeaderGuard } from "../app/utils/hostHeader.js";
import { getRouterPath } from "../app/utils/sanitizeHttpUrl.js";

const logged: string[] = [];

// Answers with the path path-matched middleware sees next to the one Remix would route on.
function pathsApp({ guarded }: { guarded: boolean }) {
  const app = express();
  if (guarded) {
    app.use(createHostHeaderGuard({ log: (line) => logged.push(line) }));
  }
  app.all("*", (req, res) => {
    const remixUrl = new URL(createRemixRequest(req, res).url);
    res.json({
      middleware: getRouterPath(req),
      // Decoded and lowercased like Remix's route matching. Fine for these inputs (no `%2F`).
      remix: decodeURIComponent(remixUrl.pathname).toLowerCase(),
    });
  });
  return app;
}

const servers: Record<"guarded" | "unguarded", http.Server> = {
  guarded: http.createServer(pathsApp({ guarded: true })),
  unguarded: http.createServer(pathsApp({ guarded: false })),
};

beforeAll(async () => {
  await Promise.all(
    Object.values(servers).map((s) => new Promise<void>((resolve) => s.listen(0, resolve)))
  );
});

afterAll(async () => {
  await Promise.all(
    Object.values(servers).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

// Raw node:http so the request target and Host go out byte for byte, with no client normalization.
function send(
  server: http.Server,
  target: string,
  host: string
): Promise<{ status: number; body: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: target, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createHostHeaderGuard", () => {
  // Catches: a Host that ends the URL authority early reaching Remix and moving the routed path,
  // or one Remix can't parse at all (a 500 instead of a 400).
  it.each([
    "x\\api\\v1\\runs?a=",
    "x\\otel\\v1\\traces?",
    "x\\login?",
    "x#/api",
    "x/api",
    "u@x",
    "x?",
    "[:::]",
  ])("rejects Host %s", async (host) => {
    expect((await send(servers.guarded, "/healthcheck", host)).status).toBe(400);
  });

  // Catches: rejections leaving no trace, since the guard runs before the access log.
  it("logs a rejection with the Host quoted", async () => {
    logged.length = 0;
    await send(servers.guarded, "/healthcheck?token=secret", "x\\login?");
    expect(logged).toEqual(['GET /healthcheck 400 - rejected Host "x\\\\login?"']);
  });

  // Catches: the guard turning away real traffic (load balancer health checks use the target IP).
  it.each(["localhost:3030", "api.trigger.dev", "10.0.1.2:3000", "[::1]:3000", "webapp_1:3000"])(
    "allows Host %s",
    async (host) => {
      expect((await send(servers.guarded, "/healthcheck", host)).status).toBe(200);
    }
  );
});

describe("getRouterPath", () => {
  // Catches: middleware matching a different path from the one Remix builds from Host + target.
  it.each([
    ["/healthcheck", "x\\api\\v1\\runs?a="],
    ["//x/api/v1/runs", "localhost"],
    ["/%61pi/v1/runs", "localhost"],
  ])("sees the path Remix routes for %s with Host %s", async (target, host) => {
    const res = await send(servers.unguarded, target, host);
    expect(res.status).toBe(200);
    const { middleware, remix } = JSON.parse(res.body);
    expect(middleware).toBe(remix);
  });
});
