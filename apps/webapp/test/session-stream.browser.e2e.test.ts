/**
 * Browser-level session-stream e2e.
 *
 * Same full stack as session-stream.e2e.test.ts, but the client is a real
 * Chromium page on a DIFFERENT origin than the webapp, driven via
 * page.evaluate. It exercises what node-fetch can't: a real browser doing a
 * cross-origin fetch + streaming read of the session `.out` SSE through the
 * webapp proxy, so the browser enforces the CORS preflight + response headers
 * the customer scenario depends on (a frontend on its own origin subscribing
 * to the API). The webapp runs production-mode here, so this checks the
 * production CORS path, not the dev-server one.
 *
 * Requires a pre-built webapp (pnpm run build --filter webapp) and Chromium
 * (pnpm exec playwright install chromium).
 */
import { randomBytes } from "crypto";
import { createServer, type Server } from "http";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionStreamTestServer } from "@internal/testcontainers/webapp";
import { startSessionStreamTestServer } from "@internal/testcontainers/webapp";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import {
  mintSessionToken,
  SessionStreamProducer,
  sessionStreamName,
} from "./helpers/sessionStream";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let server: SessionStreamTestServer;
let browser: Browser | undefined;
let origin: Server;
let originUrl: string;

beforeAll(async () => {
  server = await startSessionStreamTestServer();
  try {
    browser = await chromium.launch();
  } catch (error) {
    console.warn("[browser-e2e] Chromium unavailable, leg will skip:", String(error));
  }
  origin = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>origin</body></html>");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()));
  const addr = origin.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  originUrl = `http://127.0.0.1:${port}`;
}, 240_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await new Promise<void>((resolve) => (origin ? origin.close(() => resolve()) : resolve()));
  await server?.stop();
}, 120_000);

describe("session stream browser e2e", () => {
  it("EB1: a cross-origin browser subscribes to .out and streams records", async (ctx) => {
    if (!browser) {
      ctx.skip();
      return;
    }
    const { organization, environment, apiKey } = await seedTestEnvironment(server.prisma);
    const addressingKey = `sess-${randomBytes(6).toString("hex")}`;
    const token = await mintSessionToken({ apiKey, envId: environment.id, addressingKey });
    const streamName = sessionStreamName({
      orgId: organization.id,
      envSlug: environment.slug,
      envId: environment.id,
      addressingKey,
    });
    const producer = new SessionStreamProducer({
      endpoint: server.s2.endpoint,
      basin: server.s2.basin,
      streamName,
    });

    await producer.appendData({ n: 0 }, "p0");
    await producer.appendData({ n: 1 }, "p1");
    await producer.appendTurnComplete();

    const sseUrl = `${server.webapp.baseUrl}/realtime/v1/sessions/${encodeURIComponent(
      addressingKey
    )}/out`;

    const page = await browser.newPage();
    try {
      await page.goto(originUrl);
      const result = await page.evaluate(
        async ({ url, token }) => {
          const ac = new AbortController();
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
              signal: ac.signal,
            });
            const reader = (res.body as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let text = "";
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
              const { done, value } = await reader.read();
              if (done) break;
              text += decoder.decode(value, { stream: true });
              if (text.includes('"records"')) break;
            }
            ac.abort();
            return {
              ok: res.ok,
              status: res.status,
              sawBatch: text.includes('"records"'),
              pageOrigin: location.origin,
            };
          } catch (e) {
            return { error: String(e) };
          }
        },
        { url: sseUrl, token }
      );

      expect("error" in result ? result.error : undefined).toBeUndefined();
      expect(result).toMatchObject({ ok: true, status: 200, sawBatch: true });
      expect((result as { pageOrigin: string }).pageOrigin).toBe(originUrl);
      expect(originUrl).not.toBe(server.webapp.baseUrl);
    } finally {
      await page.close();
    }
  });
});
