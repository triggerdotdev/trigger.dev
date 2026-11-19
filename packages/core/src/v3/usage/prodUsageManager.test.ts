import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { apiClientManager } from "../apiClientManager-api.js";
import { DevUsageManager } from "./devUsageManager.js";
import { ProdUsageManager } from "./prodUsageManager.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  apiClientManager.disable();
});

const jwt = (name: string, usageAuth: string | null = "control-plane-v1") =>
  [
    "e30",
    Buffer.from(JSON.stringify({ name, usage_auth: usageAuth })).toString("base64url"),
    "sig",
  ].join(".");
const INITIAL_JWT = jwt("initial");
const REPLACEMENT_JWT = jwt("replacement");

async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  heartbeatIntervalMs = 60_000,
  options: { jwt?: string; retryAmbiguousReports?: boolean } = {}
) {
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const manager = new ProdUsageManager(new DevUsageManager(), {
    url: `http://127.0.0.1:${address.port}`,
    jwt: options.jwt ?? INITIAL_JWT,
    heartbeatIntervalMs,
    retryAmbiguousReports: options.retryAmbiguousReports,
  });
  cleanups.push(() => manager.disable());
  return manager;
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as { durationMs: number };
}

describe("production usage accounting", () => {
  // Catches: 401s dropping deltas and concurrent flushes charging the same cumulative sample twice.
  it("coalesces rejected deltas, installs the live JWT and never forwards SDK configuration", async () => {
    const accepted: number[] = [];
    let heartbeatArrived!: () => void;
    const arrived = new Promise<void>((resolve) => (heartbeatArrived = resolve));
    let releaseHeartbeat!: () => void;
    const release = new Promise<void>((resolve) => (releaseHeartbeat = resolve));
    const credentials: (string | string[] | undefined)[] = [];
    const customerKeys: (string | string[] | undefined)[] = [];
    const manager = await fixture(async (req, res) => {
      const event = await body(req);
      credentials.push(req.headers["x-trigger-jwt"]);
      customerKeys.push(req.headers.authorization);
      if (req.headers["x-trigger-jwt"] === INITIAL_JWT) {
        heartbeatArrived();
        await release;
        res.writeHead(401).end();
      } else {
        accepted.push(event.durationMs);
        await sleep(20);
        res.writeHead(200).end();
      }
    }, 10);
    apiClientManager.setGlobalAPIClientConfiguration({ accessToken: "customer-configured-key" });
    const measurement = manager.start();
    await arrived;
    await sleep(10);
    const sample = manager.stop(measurement);
    expect(sample.cpuTime).toBeGreaterThan(0);
    expect(manager.setJwt(REPLACEMENT_JWT)).toBe(true);
    const finalFlush = manager.flush();
    const concurrentFlush = manager.flush();
    releaseHeartbeat();
    await Promise.all([finalFlush, concurrentFlush]);
    await manager.flush();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toBeCloseTo(sample.cpuTime);
    expect(credentials).toEqual([INITIAL_JWT, REPLACEMENT_JWT]);
    expect(customerKeys).toEqual([undefined, undefined]);
  });

  // Catches: blindly retrying an accepted report whose HTTP response was lost, double charging it.
  it("does not retry an ambiguous report after the server accepted it and disconnected", async () => {
    const accepted: number[] = [];
    const manager = await fixture(async (req, res) => {
      accepted.push((await body(req)).durationMs);
      res.destroy();
    });
    const measurement = manager.start();
    await sleep(10);
    manager.stop(measurement);
    await manager.flush();
    await manager.flush();
    expect(accepted).toHaveLength(1);
  });

  // Catches: a credential the control plane cannot renew losing its API-key recovery path.
  it("sends the configured API key only with a non-renewable credential", async () => {
    const keys: (string | undefined)[] = [];
    const manager = await fixture(
      async (req, res) => {
        await body(req);
        keys.push(req.headers.authorization);
        res.writeHead(200).end();
      },
      60_000,
      { jwt: jwt("legacy", null) }
    );
    apiClientManager.setGlobalAPIClientConfiguration({ accessToken: "tr_prod_key" });
    const measurement = manager.start();
    await sleep(10);
    manager.stop(measurement);
    await manager.flush();
    expect(keys).toEqual(["Bearer tr_prod_key"]);
  });

  // Catches: an ambiguous report being dropped, or resent under a new id that billing cannot dedup.
  it("resends an ambiguous report under the same id when retries are enabled", async () => {
    const reports: { id: string | undefined; durationMs: number }[] = [];
    const manager = await fixture(
      async (req, res) => {
        const event = await body(req);
        reports.push({
          id: req.headers["x-trigger-usage-report-id"] as string,
          durationMs: event.durationMs,
        });
        if (reports.length === 1) return void res.writeHead(502).end();
        if (reports.length === 2) return void res.writeHead(401).end();
        res.writeHead(200).end();
      },
      60_000,
      { retryAmbiguousReports: true }
    );
    const measurement = manager.start();
    await sleep(10);
    manager.stop(measurement);
    await manager.flush();
    await manager.flush();
    await manager.flush();
    await manager.flush();
    expect(reports).toHaveLength(3);
    expect(reports[0]!.id).toBeDefined();
    expect(reports[1]).toEqual(reports[0]);
    expect(reports[2]).toEqual(reports[0]);
  });
});
