import express from "express";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AVATAR_MAX_INGRESS_BYTES,
  DASHBOARD_AGENT_MAX_INGRESS_BYTES,
  dashboardAgentBodyCap,
} from "~/services/dashboardAgentBodyCap.server";
import { MAX_AVATAR_SIZE_IN_BYTES } from "~/utils/avatarLimits";

// The cap has to hold for a body with no `content-length`: that is the case a route-level
// check can't cover, because by then the body is already in memory.

let server: Server | undefined;

/** A server whose route stands in for Remix: it reads the whole body, like `text()` would. */
async function listen(): Promise<{ url: string; buffered: () => number }> {
  let buffered = 0;
  const app = express();
  app.use(dashboardAgentBodyCap);
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

/**
 * `node:http` sends the path verbatim; `fetch` resolves dot segments client-side, so it cannot
 * express this request at all.
 */
function postRawPath(url: string, path: string, bytes: number) {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const request = http.request(
      { port: Number(new URL(url).port), method: "POST", path },
      (response) => {
        response.resume();
        settled = true;
        resolve(response.statusCode ?? 0);
        request.destroy();
      }
    );

    // A refusal tears the socket down mid-write; that is the pass, not an error.
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(Buffer.alloc(bytes, "a"));
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
      `${url}/api/v1/Dashboard-Agent/watches/batch-check`,
      DASHBOARD_AGENT_MAX_INGRESS_BYTES * 4
    );

    expect(response.status).toBe(413);
  });

  it("caps a DELETE, which reads a body on the alerts route", async () => {
    const { url } = await listen();

    const response = await fetch(`${url}/api/v1/dashboard-agent/alerts/ch_1`, {
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

  it("refuses an oversized avatar upload before it is buffered", async () => {
    const { url, buffered } = await listen();
    const oversized = AVATAR_MAX_INGRESS_BYTES + 512 * 1024;

    const response = await postChunked(`${url}/resources/account/avatar`, oversized).catch(
      () => undefined
    );

    if (response) expect(response.status).toBe(413);
    expect(buffered()).toBeLessThan(oversized);
  });

  it("caps a dot segment, which the adapter normalizes away before the action runs", async () => {
    const { url, buffered } = await listen();

    // `/…/avatar/.` reaches the route as `/…/avatar/`, so the cap has to see it that way too.
    const status = await postRawPath(
      url,
      "/resources/account/avatar/.",
      AVATAR_MAX_INGRESS_BYTES + 1
    );

    expect(status).toBe(413);
    expect(buffered()).toBe(0);
  });

  it("passes an avatar body exactly at the image cap through untouched", async () => {
    const { url, buffered } = await listen();

    const response = await postChunked(`${url}/resources/account/avatar`, MAX_AVATAR_SIZE_IN_BYTES);

    expect(response.status).toBe(200);
    expect(buffered()).toBe(MAX_AVATAR_SIZE_IN_BYTES);
  });

  it("leaves the presigned avatar GET path uncapped", async () => {
    const { url, buffered } = await listen();
    const size = AVATAR_MAX_INGRESS_BYTES + 1024;

    const response = await fetch(`${url}/resources/account/avatar/user_1/abc.png`, {
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
