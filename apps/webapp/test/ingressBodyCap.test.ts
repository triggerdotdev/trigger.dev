import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_AGENT_MAX_INGRESS_BYTES,
  createIngressBodyCap,
  DASHBOARD_AGENT_INGRESS_CAP,
  otlpIngressCap,
} from "~/services/ingressBodyCap.server";

// The cap has to hold for a body with no `content-length`: that is the case a route-level
// check can't cover, because by then the body is already in memory.

const OTLP_MAX_INGRESS_BYTES = 256 * 1024;

let server: Server | undefined;

/** A server whose route stands in for Remix: it reads the whole body, like `text()` would. */
async function listen(): Promise<{ url: string; buffered: () => number }> {
  let buffered = 0;
  const app = express();
  app.use(
    createIngressBodyCap([DASHBOARD_AGENT_INGRESS_CAP, otlpIngressCap(OTLP_MAX_INGRESS_BYTES)])
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
  };
}

/** A chunked POST: `fetch` omits `content-length` for a stream body. */
function postChunked(url: string, totalBytes: number, chunkBytes = 16 * 1024) {
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
    method: "POST",
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

  it("leaves every other path alone", async () => {
    const { url, buffered } = await listen();
    const size = DASHBOARD_AGENT_MAX_INGRESS_BYTES + 1024;

    const response = await fetch(`${url}/api/v1/artifacts`, {
      method: "POST",
      body: "x".repeat(size),
    });

    expect(response.status).toBe(200);
    expect(buffered()).toBe(size);
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
      createIngressBodyCap([{ ...otlpIngressCap(OTLP_MAX_INGRESS_BYTES), refuse: () => {} }])
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
