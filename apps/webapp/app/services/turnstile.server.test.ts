import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verifyTurnstileToken } from "./turnstile.server";

const ALWAYS_PASSES_SECRET = "1x0000000000000000000000000000000AA";
const ALWAYS_FAILS_SECRET = "2x0000000000000000000000000000000AA";
const ALREADY_SPENT_SECRET = "3x0000000000000000000000000000000AA";

describe("verifyTurnstileToken against Cloudflare's siteverify", () => {
  it("passes a token when Cloudflare accepts it", async () => {
    const result = await verifyTurnstileToken({
      secretKey: ALWAYS_PASSES_SECRET,
      token: "XXXX.DUMMY.TOKEN.XXXX",
      remoteIp: "203.0.113.7",
    });

    expect(result).toEqual({ outcome: "passed" });
  }, 15_000);

  it("fails a token Cloudflare rejects", async () => {
    const result = await verifyTurnstileToken({
      secretKey: ALWAYS_FAILS_SECRET,
      token: "XXXX.DUMMY.TOKEN.XXXX",
    });

    expect(result).toEqual({
      outcome: "failed",
      errorCodes: ["invalid-input-response"],
      misconfigured: false,
    });
  }, 15_000);

  it("fails a token that was already spent", async () => {
    const result = await verifyTurnstileToken({
      secretKey: ALREADY_SPENT_SECRET,
      token: "XXXX.DUMMY.TOKEN.XXXX",
    });

    expect(result).toEqual({
      outcome: "failed",
      errorCodes: ["timeout-or-duplicate"],
      misconfigured: false,
    });
  }, 15_000);

  it("fails closed and flags a misconfigured secret", async () => {
    const result = await verifyTurnstileToken({
      secretKey: "not-a-real-secret",
      token: "XXXX.DUMMY.TOKEN.XXXX",
    });

    expect(result).toEqual({
      outcome: "failed",
      errorCodes: ["invalid-input-secret"],
      misconfigured: true,
    });
  }, 15_000);
});

type SiteverifyHandler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: ReturnType<typeof createServer>[] = [];

async function startSiteverify(handler: SiteverifyHandler) {
  const requests: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(new URLSearchParams(body));
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/siteverify`, requests };
}

async function stopServers() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

afterEach(stopServers);

describe("verifyTurnstileToken against a local siteverify server", () => {
  it("sends the secret, token and client IP as a form body", async () => {
    const siteverify = await startSiteverify((_req, res) => sendJson(res, 200, { success: true }));

    await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      remoteIp: "203.0.113.7",
      siteverifyUrl: siteverify.url,
    });

    expect(siteverify.requests).toHaveLength(1);
    expect(siteverify.requests[0].get("secret")).toBe("secret");
    expect(siteverify.requests[0].get("response")).toBe("token");
    expect(siteverify.requests[0].get("remoteip")).toBe("203.0.113.7");
  });

  it("omits remoteip when the client IP is unknown", async () => {
    const siteverify = await startSiteverify((_req, res) => sendJson(res, 200, { success: true }));

    await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      remoteIp: null,
      siteverifyUrl: siteverify.url,
    });

    expect(siteverify.requests[0].has("remoteip")).toBe(false);
  });

  it("fails a missing token without calling siteverify", async () => {
    const siteverify = await startSiteverify((_req, res) => sendJson(res, 200, { success: true }));

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: undefined,
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({
      outcome: "failed",
      errorCodes: ["missing-input-response"],
      misconfigured: false,
    });
    expect(siteverify.requests).toHaveLength(0);
  });

  it("fails a token error even with a non-2xx status", async () => {
    const siteverify = await startSiteverify((_req, res) =>
      sendJson(res, 400, { success: false, "error-codes": ["invalid-input-response"] })
    );

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "bad",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({
      outcome: "failed",
      errorCodes: ["invalid-input-response"],
      misconfigured: false,
    });
  });

  it("fails a rejection that carries no error codes", async () => {
    const siteverify = await startSiteverify((_req, res) =>
      sendJson(res, 200, { success: false, "error-codes": [] })
    );

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({ outcome: "failed", errorCodes: [], misconfigured: false });
  });

  it("fails a token error even when success is true", async () => {
    const siteverify = await startSiteverify((_req, res) =>
      sendJson(res, 200, { success: true, "error-codes": ["invalid-input-response"] })
    );

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({
      outcome: "failed",
      errorCodes: ["invalid-input-response"],
      misconfigured: false,
    });
  });

  it("is unavailable on a JSON response with no verdict", async () => {
    const siteverify = await startSiteverify((_req, res) => sendJson(res, 200, { hostname: "x" }));

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({
      outcome: "unavailable",
      reason: "siteverify returned 200 without a verdict",
    });
  });

  it("is unavailable on a JSON 429 with no verdict", async () => {
    const siteverify = await startSiteverify((_req, res) =>
      sendJson(res, 429, { message: "rate limited" })
    );

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({
      outcome: "unavailable",
      reason: "siteverify returned 429 without a verdict",
    });
  });

  it("is unavailable on Cloudflare's internal-error", async () => {
    const siteverify = await startSiteverify((_req, res) =>
      sendJson(res, 200, { success: false, "error-codes": ["internal-error"] })
    );

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({
      outcome: "unavailable",
      reason: "siteverify returned 200 (internal-error)",
    });
  });

  it("is unavailable on a 5xx", async () => {
    const siteverify = await startSiteverify((_req, res) =>
      sendJson(res, 503, { success: false, "error-codes": [] })
    );

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result).toEqual({ outcome: "unavailable", reason: "siteverify returned 503" });
  });

  it("is unavailable when the body isn't JSON", async () => {
    const siteverify = await startSiteverify((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad gateway</html>");
    });

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result.outcome).toBe("unavailable");
  });

  it("is unavailable when siteverify never responds", async () => {
    const siteverify = await startSiteverify(() => {});

    const startedAt = Date.now();
    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
      timeoutMs: 200,
    });

    expect(result.outcome).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds reading a body that stalls after the headers", async () => {
    const siteverify = await startSiteverify((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"succ');
    });

    const startedAt = Date.now();
    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
      timeoutMs: 200,
    });

    expect(result.outcome).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("is unavailable when siteverify can't be reached", async () => {
    const siteverify = await startSiteverify((_req, res) => sendJson(res, 200, { success: true }));
    await stopServers();

    const result = await verifyTurnstileToken({
      secretKey: "secret",
      token: "token",
      siteverifyUrl: siteverify.url,
    });

    expect(result.outcome).toBe("unavailable");
  });
});
