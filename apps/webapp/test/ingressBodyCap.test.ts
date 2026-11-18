import { createRequestHandler } from "@remix-run/express";
import express, { type ErrorRequestHandler } from "express";
import http, { type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_AGENT_MAX_INGRESS_BYTES,
  createIngressBodyCap,
  createKeyedAllowance,
  createRouteIdMatcher,
  DASHBOARD_AGENT_INGRESS_CAP,
  ignoreRefusedBodyErrors,
  OAUTH_INGRESS_CAP,
  otlpIngressCap,
  routeIngressCaps,
  SIGN_IN_FORM_INGRESS_CAP,
  type IngressBodyCapOptions,
  type IngressBodyLimitEvent,
  type RouteBodyLimits,
} from "~/services/ingressBodyCap.server";

// The cap has to hold for a body with no `content-length`: that is the case a route-level
// check can't cover, because by then the body is already in memory.

const OTLP_MAX_INGRESS_BYTES = 256 * 1024;
const DEFAULT_LIMIT_BYTES = 1024 * 1024;

/** The shipped defaults of the settings the listed routes read, with a larger webhook limit. */
const ROUTE_LIMITS: RouteBodyLimits = {
  taskPayloadBytes: 3_145_728,
  batchPayloadBytes: 1_000_000,
  streamingBatchItemBytes: 3_145_728,
  streamingBatchMaxItems: 1_000,
  webhookBodyBytes: 2 * 1024 * 1024,
  runMetadataBytes: 262_144,
};

const CAPS = [
  DASHBOARD_AGENT_INGRESS_CAP,
  SIGN_IN_FORM_INGRESS_CAP,
  OAUTH_INGRESS_CAP,
  otlpIngressCap(OTLP_MAX_INGRESS_BYTES),
  ...routeIngressCaps(ROUTE_LIMITS),
];

let server: Server | undefined;

/** A server whose route stands in for Remix: it reads the whole body, like `text()` would. */
async function listen(options: Partial<IngressBodyCapOptions> = {}): Promise<{
  url: string;
  buffered: () => number;
  events: IngressBodyLimitEvent[];
  sizes: Array<{ cap: string; bytes: number }>;
}> {
  let buffered = 0;
  const events: IngressBodyLimitEvent[] = [];
  const sizes: Array<{ cap: string; bytes: number }> = [];
  const app = express();
  app.use(
    createIngressBodyCap({
      caps: CAPS,
      defaultLimitBytes: DEFAULT_LIMIT_BYTES,
      mode: "enforce",
      onExceeded: (event) => events.push(event),
      onMeasured: (cap, bytes) => sizes.push({ cap, bytes }),
      ...options,
    })
  );
  app.all("*", async (req, res) => {
    try {
      for await (const chunk of req) buffered += (chunk as Buffer).byteLength;
    } catch {
      // The cap tore the request down; that is the point.
      return;
    }
    res.status(200).json({ bytes: buffered });
  });

  server = app.listen(0);
  await new Promise((resolve) => server!.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    buffered: () => buffered,
    events,
    sizes,
  };
}

/** A chunked POST: `fetch` omits `content-length` for a stream body. */
function postChunked(url: string, totalBytes: number, chunkBytes = 16 * 1024, method = "POST") {
  let left = totalBytes;
  const body = new Readable({
    read() {
      if (left <= 0) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkBytes, left);
      left -= size;
      this.push(Buffer.alloc(size, "a"));
    },
  });

  return fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: Readable.toWeb(body) as ReadableStream,
    // @ts-expect-error — undici needs this for a streamed request body.
    duplex: "half",
  });
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe("the dashboard agent's ingress cap", () => {
  it("refuses a chunked oversized body without buffering it", async () => {
    const { url, buffered } = await listen();
    const oversized = DASHBOARD_AGENT_MAX_INGRESS_BYTES * 20;

    // A client still uploading may see the reset rather than read the 413; either way the
    // request is over long before the body is.
    const response = await postChunked(
      `${url}/resources/orgs/acme/projects/site/env/dev/dashboard-agent/in/append`,
      oversized
    ).catch(() => undefined);

    if (response) expect(response.status).toBe(413);
    expect(buffered()).toBeLessThan(oversized / 2);
  });

  it("answers 413 for a chunked body a little over the cap", async () => {
    const { url } = await listen();

    const response = await postChunked(
      `${url}/resources/orgs/acme/projects/site/env/dev/dashboard-agent/in/append`,
      DASHBOARD_AGENT_MAX_INGRESS_BYTES + 32 * 1024
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "message_too_large" });
  });

  it("refuses a declared oversized body before reading anything", async () => {
    const { url, buffered } = await listen();
    const response = await fetch(
      `${url}/resources/orgs/acme/projects/site/env/dev/dashboard-agent`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x".repeat(DASHBOARD_AGENT_MAX_INGRESS_BYTES + 1),
      }
    );

    expect(response.status).toBe(413);
    expect(buffered()).toBe(0);
  });

  it("passes a body under the cap through untouched", async () => {
    const { url } = await listen();
    const size = 32 * 1024;

    const response = await postChunked(
      `${url}/resources/orgs/acme/projects/site/env/dev/dashboard-agent`,
      size
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
  });

  it("caps a mixed-case path, because Remix matches routes case-insensitively", async () => {
    const { url } = await listen();

    const response = await postChunked(
      `${url}/api/v1/Dashboard-Agent/monitoring-alerts`,
      DASHBOARD_AGENT_MAX_INGRESS_BYTES * 4
    );

    expect(response.status).toBe(413);
  });

  // Catches: a percent-encoded path skipping the cap while Remix still routes it to the agent.
  it("caps a percent-encoded path, because Remix decodes it before routing", async () => {
    const { url } = await listen();

    const response = await postChunked(
      `${url}/%61pi/v1/dashboard-%61gent/watches/batch-check`,
      DASHBOARD_AGENT_MAX_INGRESS_BYTES * 4
    );

    expect(response.status).toBe(413);
  });

  it("caps a DELETE, which reads a body on the alerts route", async () => {
    const { url } = await listen();

    const response = await fetch(`${url}/api/v1/dashboard-agent/monitoring-alerts`, {
      method: "DELETE",
      body: "x".repeat(DASHBOARD_AGENT_MAX_INGRESS_BYTES + 1024),
    });

    expect(response.status).toBe(413);
  });

  it("leaves a body over its own cap alone on every other path", async () => {
    const { url, buffered } = await listen();
    const size = DASHBOARD_AGENT_MAX_INGRESS_BYTES + 1024;

    const response = await fetch(`${url}/api/v1/artifacts`, {
      method: "POST",
      body: "x".repeat(size),
    });

    expect(response.status).toBe(200);
    expect(buffered()).toBe(size);
  });

  // Catches: the dashboard agent limit turning into a log line when the mode is shadow.
  it("still refuses in shadow mode", async () => {
    const { url } = await listen({ mode: "shadow" });

    const response = await postChunked(
      `${url}/api/v1/dashboard-agent/monitoring-alerts`,
      DASHBOARD_AGENT_MAX_INGRESS_BYTES + 32 * 1024
    );

    expect(response.status).toBe(413);
  });

  it("does not cap a lookalike that only carries the chat segment mid-path", async () => {
    const { url, buffered } = await listen();
    const size = DASHBOARD_AGENT_MAX_INGRESS_BYTES + 1024;

    const response = await fetch(`${url}/api/v1/runs/env/dev/dashboard-agent`, {
      method: "POST",
      body: "x".repeat(size),
    });

    expect(response.status).toBe(200);
    expect(buffered()).toBe(size);
  });

  it("does not cap a task whose id is literally dashboard-agent", async () => {
    const { url, buffered } = await listen();
    const size = DASHBOARD_AGENT_MAX_INGRESS_BYTES + 1024;

    const response = await fetch(`${url}/api/v1/tasks/dashboard-agent/trigger`, {
      method: "POST",
      body: "x".repeat(size),
    });

    expect(response.status).toBe(200);
    expect(buffered()).toBe(size);
  });
});

describe("the OTLP ingress cap", () => {
  it("catches a chunked upload with no content-length being buffered whole", async () => {
    const { url, buffered } = await listen();
    const oversized = OTLP_MAX_INGRESS_BYTES * 20;

    const response = await postChunked(`${url}/otel/v1/traces`, oversized, 16 * 1024).catch(
      () => undefined
    );

    if (response) expect(response.status).toBe(413);
    expect(buffered()).toBeLessThan(oversized / 2);
  });

  it("catches a declared oversized body being read before it is refused", async () => {
    const { url, buffered } = await listen();
    const response = await fetch(`${url}/otel/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: Buffer.alloc(OTLP_MAX_INGRESS_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
    expect(buffered()).toBe(0);
  });

  it.each(["/OTEL/v1/traces", "/%6Ftel/v1/logs"])(
    "catches %s skipping the cap while the router still serves it",
    async (path) => {
      const { url } = await listen();
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        body: Buffer.alloc(OTLP_MAX_INGRESS_BYTES + 1),
      });

      expect(response.status).toBe(413);
    }
  );

  it("catches a resumed body reader buffering past the cap while the 413 is queued", async () => {
    let buffered = 0;
    const app = express();
    app.use(
      createIngressBodyCap({
        caps: [{ ...otlpIngressCap(OTLP_MAX_INGRESS_BYTES), refuse: () => {} }],
        defaultLimitBytes: DEFAULT_LIMIT_BYTES,
        mode: "enforce",
      })
    );
    app.all("*", (req, res) => {
      req.on("data", (chunk: Buffer) => {
        buffered += chunk.byteLength;
        req.resume();
      });
      req.on("end", () => res.status(200).end());
      req.resume();
    });
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const oversized = OTLP_MAX_INGRESS_BYTES * 20;

    await postChunked(`${url}/otel/v1/traces`, oversized).catch(() => undefined);

    expect(buffered).toBeLessThanOrEqual(OTLP_MAX_INGRESS_BYTES * 2);
  });

  it("catches an off-by-one refusing a body exactly at the cap", async () => {
    const { url } = await listen();

    const response = await postChunked(`${url}/otel/v1/traces`, OTLP_MAX_INGRESS_BYTES, 16 * 1024);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: OTLP_MAX_INGRESS_BYTES });
  });
});

describe("the default limit", () => {
  // Catches: a route that is not listed being served a body of any size.
  it("refuses a chunked body over the default on a route with no limit of its own", async () => {
    const { url, buffered, events } = await listen();
    const oversized = DEFAULT_LIMIT_BYTES * 20;

    const response = await postChunked(`${url}/api/v1/schedules`, oversized).catch(() => undefined);

    if (response) expect(response.status).toBe(413);
    expect(buffered()).toBeLessThan(oversized / 2);
    expect(events).toMatchObject([{ cap: "default", declared: false, enforced: true }]);
  });

  // Catches: a refusal that resets the connection before the client can read the 413.
  it("answers 413 for a chunked body a little over the default", async () => {
    const { url } = await listen();

    const response = await postChunked(`${url}/api/v1/artifacts`, DEFAULT_LIMIT_BYTES + 32 * 1024);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large" });
  });

  // Catches: a body whose declared length is already over the limit being read first.
  it("refuses a declared body over the default before reading anything", async () => {
    const { url, buffered, events } = await listen();

    const response = await fetch(`${url}/api/v1/schedules`, {
      method: "POST",
      body: Buffer.alloc(DEFAULT_LIMIT_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(buffered()).toBe(0);
    expect(events).toMatchObject([
      { cap: "default", bytes: DEFAULT_LIMIT_BYTES + 1, declared: true, enforced: true },
    ]);
  });

  // Catches: an off-by-one refusing a body exactly at the default.
  it("passes a body exactly at the default", async () => {
    const { url, events } = await listen();

    const response = await postChunked(`${url}/api/v1/schedules`, DEFAULT_LIMIT_BYTES);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: DEFAULT_LIMIT_BYTES });
    expect(events).toEqual([]);
  });

  // Catches: the default applying to POST only while the router reads a body for these methods too.
  it.each(["PUT", "PATCH", "DELETE", "OPTIONS"])("applies to %s", async (method) => {
    const { url } = await listen();

    const response = await postChunked(
      `${url}/api/v1/projects/proj_1/envvars/dev/NAME`,
      DEFAULT_LIMIT_BYTES + 32 * 1024,
      16 * 1024,
      method
    );

    expect(response.status).toBe(413);
  });

  // Catches: a GET being counted or refused, which the router never reads a body for.
  it("leaves a GET alone", async () => {
    const { url, buffered } = await listen();
    const size = DEFAULT_LIMIT_BYTES + 32 * 1024;

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const options = { method: "GET", headers: { "content-length": size } };
      const request = http.request(`${url}/api/v1/schedules`, options, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end(Buffer.alloc(size));
    });

    expect(status).toBe(200);
    expect(buffered()).toBe(size);
  });

  // Catches: a handler taking the part of a refused body that arrived for the whole body.
  it("fails the read of a refused body instead of ending it", async () => {
    let ended = false;
    let failure: Error | undefined;
    const app = express();
    app.use(
      createIngressBodyCap({ caps: [], defaultLimitBytes: DEFAULT_LIMIT_BYTES, mode: "enforce" })
    );
    app.all("*", (req) => {
      req.on("data", () => {});
      req.on("end", () => (ended = true));
      req.on("error", (error) => (failure = error));
      req.resume();
    });
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    const response = await postChunked(`${url}/api/v1/schedules`, DEFAULT_LIMIT_BYTES + 64 * 1024);
    await response.arrayBuffer().catch(() => undefined);
    await expect.poll(() => failure?.name).toBe("AbortError");

    expect(response.status).toBe(413);
    expect(ended).toBe(false);
  });
});

describe("the connection of a refused request", () => {
  // Catches: a connection left open with the rest of the upload unread until it times out.
  it.each(["chunked", "declared"])("closes once the 413 is sent, for a %s body", async (kind) => {
    const { url } = await listen();
    const { port } = new URL(url);

    const socket = net.connect(Number(port), "127.0.0.1");
    let response = "";
    socket.on("data", (data) => (response += data.toString()));
    const started = Date.now();
    const closed = new Promise<number>((resolve) => {
      socket.on("close", () => resolve(Date.now() - started));
    });
    socket.on("error", () => {});
    const chunk = Buffer.alloc(2 * DEFAULT_LIMIT_BYTES, "a");
    socket.write(
      "POST /api/v1/schedules HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n" +
        (kind === "chunked"
          ? "Transfer-Encoding: chunked\r\n\r\n"
          : `Content-Length: ${4 * DEFAULT_LIMIT_BYTES}\r\n\r\n`)
    );
    if (kind === "chunked") socket.write(`${chunk.byteLength.toString(16)}\r\n`);
    socket.write(chunk);
    if (kind === "chunked") socket.write("\r\n");
    // The upload is never finished.

    expect(await closed).toBeLessThan(1000);
    expect(response).toMatch(/^HTTP\/1\.1 413/);
  });
});

describe("a handler that answers after its request was refused", () => {
  async function listenWithLateAnswer() {
    const errors: unknown[] = [];
    const app = express();
    app.use(
      createIngressBodyCap({ caps: [], defaultLimitBytes: DEFAULT_LIMIT_BYTES, mode: "enforce" })
    );
    app.all("*", (req, res, next) => {
      req.on("data", () => {});
      req.on("error", () => {
        try {
          res.status(500).append("content-type", "text/plain").end();
        } catch (error) {
          next(error);
        }
      });
      req.on("end", () => next(new Error("unrelated failure")));
      req.resume();
    });
    app.use(ignoreRefusedBodyErrors);
    const collect: ErrorRequestHandler = (error, _req, res, _next) => {
      errors.push(error);
      res.status(500).end();
    };
    app.use(collect);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, errors };
  }

  // Catches: the handler's answer to a refused request surfacing as a server error.
  it("drops the late answer", async () => {
    const { url, errors } = await listenWithLateAnswer();

    const response = await postChunked(`${url}/api/v1/schedules`, DEFAULT_LIMIT_BYTES + 64 * 1024);
    await response.arrayBuffer().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(response.status).toBe(413);
    expect(errors).toEqual([]);
  });

  // Catches: errors of requests that were never refused being swallowed.
  it("passes on the errors of every other request", async () => {
    const { url, errors } = await listenWithLateAnswer();

    const response = await postChunked(`${url}/api/v1/schedules`, 1024);

    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
  });
});

describe("a refused body read through Remix", () => {
  // Catches: the rest of an over-limit body, already buffered, completing a read the handler
  // started after the 413 was sent.
  it("fails a read that starts after the refusal", async () => {
    const reads: Array<{ ok: boolean; bytes?: number }> = [];
    const limitBytes = 64 * 1024;
    const build = {
      mode: "production",
      future: {},
      isSpaMode: false,
      basename: undefined,
      publicPath: "/build/",
      assetsBuildDirectory: "public/build",
      assets: { entry: { module: "", imports: [] }, routes: {}, url: "", version: "test" },
      entry: { module: { default: () => new Response(null, { status: 500 }) } },
      routes: {
        root: { id: "root", path: "", module: {} },
        "routes/upload": {
          id: "routes/upload",
          parentId: "root",
          path: "upload",
          module: {
            action: async ({ request }: { request: Request }) => {
              // Work before the read, so the whole body has arrived by then.
              await new Promise((resolve) => setTimeout(resolve, 100));
              try {
                const text = await request.text();
                reads.push({ ok: true, bytes: text.length });
              } catch {
                reads.push({ ok: false });
              }
              return new Response("done");
            },
          },
        },
      },
    };
    const app = express();
    app.use(createIngressBodyCap({ caps: [], defaultLimitBytes: limitBytes, mode: "enforce" }));
    // @ts-expect-error a minimal build: only what request handling uses.
    app.all("*", createRequestHandler({ build, mode: "production" }));
    app.use(ignoreRefusedBodyErrors);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    // The limit's worth, then one byte more, then the end.
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(limitBytes, "a"));
        this.push(Buffer.alloc(1, "a"));
        this.push(null);
      },
    });
    const init = {
      method: "POST",
      body: Readable.toWeb(body) as ReadableStream,
      duplex: "half" as const,
    };
    const response = await fetch(`${url}/upload`, init).catch(() => undefined);

    if (response) expect(response.status).toBe(413);
    await expect.poll(() => reads.length, { timeout: 2000 }).toBe(1);
    expect(reads[0]).toEqual({ ok: false });
  });
});

describe("the sign-in and invite forms", () => {
  const paths = ["/auth/sso", "/login/magic", "/login/mfa", "/invite-resend", "/invite-revoke"];

  // Catches: a sign-in form body over its limit being served when the mode is shadow.
  it.each(["shadow", "enforce"] as const)("refuses a body over the limit in %s", async (mode) => {
    const { url, events } = await listen({ mode });

    const response = await postChunked(
      `${url}/auth/sso`,
      SIGN_IN_FORM_INGRESS_CAP.limitBytes + 32 * 1024
    );

    expect(response.status).toBe(413);
    expect(events).toMatchObject([{ cap: "sign-in-form", enforced: true }]);
  });

  // Catches: one of the sign-in forms left on the larger default.
  it.each(paths)("holds %s to the form limit", async (path) => {
    const { url } = await listen({ mode: "shadow" });

    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `email=${"a".repeat(SIGN_IN_FORM_INGRESS_CAP.limitBytes)}`,
    });

    expect(response.status).toBe(413);
  });

  // Catches: a path the router serves with a trailing slash, left behind by a dot segment,
  // missing the limit of the route it reaches.
  it.each([
    "/auth/sso/%2e",
    "/auth/sso/.",
    "/auth/sso/x/..",
    "/login/magic/%2e",
    "/login/mfa/%2E",
    "/auth/sso/",
    "/auth/sso//",
    "/invite-resend",
    "/invite-resend/",
    "/invite-resend/%2e",
    "/invite-revoke",
    "/invite-revoke/",
    "/invite-revoke/%2e",
  ])("holds the raw request target %s to the form limit", async (target) => {
    const { url } = await listen({ mode: "shadow" });
    const { hostname, port } = new URL(url);

    // `fetch` resolves dot segments before sending, so the target is written as is.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request({ hostname, port, path: target, method: "POST" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end(Buffer.alloc(SIGN_IN_FORM_INGRESS_CAP.limitBytes + 1));
    });

    expect(status).toBe(413);
  });

  // Catches: an ordinary sign-in form being refused.
  it.each(paths)("takes an ordinary form on %s", async (path) => {
    const { url, events } = await listen({ mode: "shadow" });
    const form = `email=someone%40example.com&redirectTo=${encodeURIComponent("/orgs/acme/projects/site")}&action=send`;

    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: form.length });
    expect(events).toEqual([]);
  });
});

describe("routes with their own limit", () => {
  const triggerPath = "/api/v1/tasks/my-task/trigger";

  // Catches: a listed route being held to the default.
  it("takes a body over the default up to the route's limit", async () => {
    const { url, events } = await listen();
    const size = ROUTE_LIMITS.taskPayloadBytes;

    const response = await postChunked(`${url}${triggerPath}`, size, 64 * 1024);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
    expect(events).toEqual([]);
  });

  // Catches: a listed route having no limit at all.
  it("refuses a body over the route's limit", async () => {
    const { url, events } = await listen();

    const response = await postChunked(
      `${url}${triggerPath}`,
      ROUTE_LIMITS.taskPayloadBytes + 64 * 1024,
      64 * 1024
    );

    expect(response.status).toBe(413);
    expect(events).toMatchObject([
      { cap: "trigger-payload", limitBytes: ROUTE_LIMITS.taskPayloadBytes },
    ]);
  });

  // Catches: an encoded, mixed-case or trailing-slash path to a listed route falling back to the
  // default.
  it.each([
    "/API/v1/Tasks/my-task/Trigger",
    "/api/v1/tasks/my-task/%74rigger",
    "/api/v1/tasks/my-task/trigger/",
    "/api/v1/tasks/my-task/trigger//",
  ])("matches %s the way the router does", async (path) => {
    const { url } = await listen();
    const size = DEFAULT_LIMIT_BYTES * 2;

    const response = await postChunked(`${url}${path}`, size, 64 * 1024);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
  });

  // Catches: a longer path that starts like a listed route inheriting its larger limit.
  it("gives a path that only resembles a listed route the default", async () => {
    const { url } = await listen();

    const response = await postChunked(
      `${url}/api/v1/tasks/my-task/trigger/extra`,
      DEFAULT_LIMIT_BYTES * 2,
      64 * 1024
    );

    expect(response.status).toBe(413);
  });

  // Catches: a long-running stream upload being cut off at the default.
  it("lets a stream with no total run past the default", async () => {
    const { url, events } = await listen();
    const size = DEFAULT_LIMIT_BYTES * 3;

    const response = await postChunked(
      `${url}/realtime/v1/streams/run_123/self/my-stream`,
      size,
      64 * 1024
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
    expect(events).toEqual([]);
  });

  // Catches: a streamed batch being cut off at the default.
  it("takes a streamed batch over the default", async () => {
    const { url } = await listen();
    const size = DEFAULT_LIMIT_BYTES * 4;

    const response = await postChunked(`${url}/api/v3/batches/batch_123/items`, size, 64 * 1024);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
  });

  // Catches: a completion carrying an inline output and metadata, both within their own limits,
  // refused because the two together pass the default once JSON-escaped.
  it.each([
    "/engine/v1/worker-actions/runs/run_123/snapshots/snapshot_123/attempts/complete",
    "/engine/v1/dev/runs/run_123/snapshots/snapshot_123/attempts/complete",
  ])("takes a full attempt completion on %s", async (path) => {
    const { url, events } = await listen();
    const completion = JSON.stringify({
      completion: {
        ok: true,
        id: "run_123",
        outputType: "text/plain",
        output: "\u0000".repeat(130_000),
        metadata: { operations: [{ type: "set", key: "x", value: '"'.repeat(120_000) }] },
        flushedMetadata: {
          dataType: "application/json",
          data: JSON.stringify({ x: '"'.repeat(120_000) }),
        },
      },
    });
    expect(completion.length).toBeGreaterThan(DEFAULT_LIMIT_BYTES);

    const response = await fetch(`${url}${path}`, { method: "POST", body: completion });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: completion.length });
    expect(events).toEqual([]);
  });

  // Catches: the completion routes having no limit at all.
  it("refuses an attempt completion far over what a run can produce", async () => {
    const { url, events } = await listen();

    const response = await postChunked(
      `${url}/engine/v1/dev/runs/run_123/snapshots/snapshot_123/attempts/complete`,
      11 * 1024 * 1024,
      256 * 1024
    ).catch(() => undefined);

    if (response) expect(response.status).toBe(413);
    expect(events).toMatchObject([{ cap: "attempt-completion" }]);
  });

  // Catches: a deployment failure carrying the indexer's full output being held to the default.
  it("takes a deployment failure report over the default", async () => {
    const { url, events } = await listen();
    const size = 1_200_000;

    const response = await postChunked(`${url}/api/v1/deployments/deployment_123/fail`, size);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
    expect(events).toEqual([]);
  });

  // Catches: the deployment failure route having no limit at all.
  it("refuses a deployment failure report over its limit", async () => {
    const { url, events } = await listen();

    const response = await postChunked(
      `${url}/api/v1/deployments/deployment_123/fail`,
      5 * 1024 * 1024,
      256 * 1024
    ).catch(() => undefined);

    if (response) expect(response.status).toBe(413);
    expect(events).toMatchObject([{ cap: "deployment-failure" }]);
  });

  // Catches: the waiter callback path being held to the default when the webhook limit is larger.
  it.each(["/webhooks/v1/ingest/wh_abc", "/webhooks/v1/ingest/wh_abc/w/waiter_token"])(
    "takes a webhook body up to the webhook limit on %s",
    async (path) => {
      const { url } = await listen();
      const size = ROUTE_LIMITS.webhookBodyBytes;

      const response = await postChunked(`${url}${path}`, size, 64 * 1024);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ bytes: size });
    }
  );
});

describe("a response that is streamed", () => {
  // Catches: a streamed answer to a POST being held back until it ends.
  it.each(["shadow", "enforce"] as const)(
    "reaches the client as it is written in %s",
    async (mode) => {
      let release: (() => void) | undefined;
      const app = express();
      app.use(createIngressBodyCap({ caps: CAPS, defaultLimitBytes: DEFAULT_LIMIT_BYTES, mode }));
      app.post("*", async (req, res) => {
        for await (const _chunk of req) {
          // Read the request before answering, like a route that parses its body first.
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        await new Promise<void>((resolve) => (release = resolve));
        res.end("data: last\n\n");
      });
      server = app.listen(0);
      await new Promise((resolve) => server!.once("listening", resolve));
      const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

      const response = await fetch(`${url}/api/v3/deployments/deployment_123/finalize`, {
        method: "POST",
        body: JSON.stringify({ skipPromotion: false }),
      });
      const reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);

      // The first event arrived while the response was still open.
      expect(first).toBe("data: first\n\n");
      release!();
      const last = new TextDecoder().decode((await reader.read()).value);
      expect(last).toBe("data: last\n\n");
    }
  );
});

describe("measuring bodies", () => {
  // Catches: bodies under their limit, or on the route with no total, missing from the size record.
  it("reports the size of every body under the limit that applied", async () => {
    const { url, sizes } = await listen();

    await (await postChunked(`${url}/api/v1/schedules`, 4096)).arrayBuffer();
    await (
      await fetch(`${url}/api/v1/tasks/my-task/trigger`, { method: "POST", body: "x".repeat(2048) })
    ).arrayBuffer();
    await (
      await postChunked(`${url}/realtime/v1/streams/run_123/self/my-stream`, 8192)
    ).arrayBuffer();

    await expect.poll(() => sizes.length).toBe(3);
    expect(sizes).toEqual([
      { cap: "default", bytes: 4096 },
      { cap: "trigger-payload", bytes: 2048 },
      { cap: "realtime-stream", bytes: 8192 },
    ]);
  });

  // Catches: a refused body being recorded twice, at refusal and again at close.
  it("reports a refused body once", async () => {
    const { url, sizes } = await listen();

    await postChunked(`${url}/api/v1/schedules`, DEFAULT_LIMIT_BYTES + 64 * 1024).then((response) =>
      response.arrayBuffer().catch(() => undefined)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sizes).toHaveLength(1);
    expect(sizes[0]?.cap).toBe("default");
    expect(sizes[0]?.bytes).toBeGreaterThan(DEFAULT_LIMIT_BYTES);
  });

  // Catches: GET requests filling the size record with zeros.
  it("leaves a GET unmeasured", async () => {
    const { url, sizes } = await listen();

    await (await fetch(`${url}/api/v1/schedules`)).arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sizes).toEqual([]);
  });
});

describe("shadow mode", () => {
  // Catches: shadow mode refusing a body, or reporting it more than once.
  it("serves a body over the default and reports it once", async () => {
    const { url, events } = await listen({ mode: "shadow" });
    const size = DEFAULT_LIMIT_BYTES * 2;

    const response = await fetch(`${url}/api/v1/schedules?token=abc`, {
      method: "POST",
      headers: { cookie: "session=abc", "user-agent": `sdk/4.1.0 ${"x".repeat(200)}` },
      body: Readable.toWeb(Readable.from([Buffer.alloc(size)])) as ReadableStream,
      // @ts-expect-error: undici needs this for a streamed request body.
      duplex: "half",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toEqual({
      cap: "default",
      routerPath: "/api/v1/schedules",
      method: "POST",
      limitBytes: DEFAULT_LIMIT_BYTES,
      bytes: size,
      declared: false,
      hasAuthorization: false,
      hasCookie: true,
      userAgent: `sdk/4.1.0 ${"x".repeat(110)}`,
      enforced: false,
    });
  });

  // Catches: shadow mode refusing a body by its declared length.
  it("serves a declared body over the default and reports its declared size", async () => {
    const { url, events } = await listen({ mode: "shadow" });
    const size = DEFAULT_LIMIT_BYTES + 1;

    const response = await fetch(`${url}/api/v1/artifacts`, {
      method: "POST",
      headers: { authorization: "Bearer tr_dev_1" },
      body: Buffer.alloc(size),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: size });
    await expect.poll(() => events.length).toBe(1);
    expect(events).toMatchObject([
      { cap: "default", bytes: size, declared: true, hasAuthorization: true, enforced: false },
    ]);
  });

  // Catches: a request the handler answers without reading going unreported, because its body
  // stream never closes.
  it("reports a body over its limit that the handler never reads", async () => {
    const events: IngressBodyLimitEvent[] = [];
    const sizes: number[] = [];
    const app = express();
    app.use(
      createIngressBodyCap({
        caps: [],
        defaultLimitBytes: DEFAULT_LIMIT_BYTES,
        mode: "shadow",
        onExceeded: (event) => events.push(event),
        onMeasured: (_cap, bytes) => sizes.push(bytes),
      })
    );
    app.all("*", (req, res) => {
      // Attached but never read to the end, like a route that refuses before parsing.
      req.on("data", () => {});
      res.status(401).end();
    });
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const size = DEFAULT_LIMIT_BYTES * 4;

    const response = await fetch(`${url}/api/v1/artifacts`, {
      method: "POST",
      body: Buffer.alloc(size),
    }).catch(() => undefined);

    if (response) expect(response.status).toBe(401);
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ bytes: size, declared: true, enforced: false });
    expect(sizes).toEqual([size]);
  });

  // Catches: an event reported with the context as it was before the handler identified the caller.
  it("hands back what was captured for the request, as the handler left it", async () => {
    const seen: Array<{ tenant?: string } | undefined> = [];
    const app = express();
    const context = { tenant: undefined as string | undefined };
    app.use(
      createIngressBodyCap({
        caps: [],
        defaultLimitBytes: DEFAULT_LIMIT_BYTES,
        mode: "shadow",
        capture: () => context,
        onExceeded: (_event, captured) => seen.push(captured && { ...captured }),
      })
    );
    app.all("*", async (req, res) => {
      context.tenant = "org_123";
      for await (const _chunk of req) {
        // Drain the body.
      }
      res.status(200).end();
    });
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    await (await postChunked(`${url}/api/v1/artifacts`, DEFAULT_LIMIT_BYTES * 2)).arrayBuffer();

    await expect.poll(() => seen.length).toBe(1);
    expect(seen).toEqual([{ tenant: "org_123" }]);
  });

  // Catches: every request producing an event in shadow mode.
  it("reports nothing for a body within its limit", async () => {
    const { url, events } = await listen({ mode: "shadow" });

    const response = await postChunked(`${url}/api/v1/schedules`, DEFAULT_LIMIT_BYTES);
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(events).toEqual([]);
  });
});

describe("resolving a path to its route", () => {
  const routeIdFor = createRouteIdMatcher({
    root: { id: "root", path: "" },
    "routes/auth.sso": { id: "routes/auth.sso", parentId: "root", path: "auth/sso" },
    "routes/api.v1.runs.$runId.tags": {
      id: "routes/api.v1.runs.$runId.tags",
      parentId: "root",
      path: "api/v1/runs/:runId/tags",
    },
    "routes/_app": { id: "routes/_app", parentId: "root" },
    "routes/_app.orgs.$organizationSlug._index": {
      id: "routes/_app.orgs.$organizationSlug._index",
      parentId: "routes/_app",
      path: "orgs/:organizationSlug",
      index: true,
    },
  });

  // Catches: an event naming the raw path, ids included, where it should name the route.
  it("names the route without the ids in the path", () => {
    expect(routeIdFor("/api/v1/runs/run_abc123/tags")).toBe("routes/api.v1.runs.$runId.tags");
    expect(routeIdFor("/auth/sso")).toBe("routes/auth.sso");
  });

  // Catches: dashboard routes under a pathless layout resolving to nothing.
  it("resolves a route nested under a pathless layout", () => {
    expect(routeIdFor("/orgs/acme")).toBe("routes/_app.orgs.$organizationSlug._index");
  });

  // Catches: an unknown path being reported under some other route.
  it("returns nothing for a path no route serves", () => {
    expect(routeIdFor("/nope/nothing")).toBeUndefined();
  });
});

describe("limiting how often a key is let through", () => {
  // Catches: one route that goes over its limit on every request writing a line for each.
  it("lets the limit through in each window and counts the rest", () => {
    let now = 0;
    const allowance = createKeyedAllowance({ limit: 2, windowMs: 1000, now: () => now });

    expect(allowance("a")).toEqual({ allowed: true, heldBack: 0 });
    expect(allowance("a")).toEqual({ allowed: true, heldBack: 0 });
    expect(allowance("a")).toEqual({ allowed: false, heldBack: 0 });
    expect(allowance("a")).toEqual({ allowed: false, heldBack: 0 });

    now = 1000;
    expect(allowance("a")).toEqual({ allowed: true, heldBack: 2 });
    expect(allowance("a")).toEqual({ allowed: true, heldBack: 0 });
  });

  // Catches: a busy route using up the lines of every other route.
  it("keeps each key's allowance separate", () => {
    const allowance = createKeyedAllowance({ limit: 1, windowMs: 1000, now: () => 0 });

    expect(allowance("a").allowed).toBe(true);
    expect(allowance("a").allowed).toBe(false);
    expect(allowance("b").allowed).toBe(true);
  });
});

describe("the OAuth endpoints' ingress cap", () => {
  // Catches: dropping OAUTH_INGRESS_CAP from the list, leaving unauthenticated bodies unbounded.
  it.for(["token", "register", "revoke", "token/", "token//"])(
    "refuses an oversized /oauth/%s body",
    async (name) => {
      const { url, buffered } = await listen();

      const response = await fetch(`${url}/oauth/${name}`, {
        method: "POST",
        body: "x".repeat(DEFAULT_LIMIT_BYTES / 2),
      });

      expect(response.status).toBe(413);
      expect(buffered()).toBe(0);
    }
  );

  it("passes a normal /oauth/token body through", async () => {
    const { url } = await listen();
    const body = "grant_type=refresh_token&refresh_token=abc";

    const response = await fetch(`${url}/oauth/token`, { method: "POST", body });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: body.length });
  });
});
