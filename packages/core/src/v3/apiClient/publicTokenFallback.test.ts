import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./index.js";
import { ApiError } from "../zodfetch.js";
import { TriggerTracer } from "../tracer.js";
import type { ZodFetchOptions } from "./core.js";

const cases = [
  {
    name: "triggerTask",
    endpoint: "/api/v1/tasks/task-one/trigger",
    response: { id: "run_test" },
    scope: "read:runs:run_test",
    expirationTime: "1h",
    invoke: (client: ApiClient, options?: ZodFetchOptions) =>
      client.triggerTask("task-one", {}, undefined, options),
  },
  {
    name: "batchTriggerV3",
    endpoint: "/api/v2/tasks/batch",
    response: { id: "batch_test", runCount: 1 },
    scope: "read:batch:batch_test",
    expirationTime: "1h",
    invoke: (client: ApiClient, options?: ZodFetchOptions) =>
      client.batchTriggerV3({ items: [] }, undefined, options),
  },
  {
    name: "createBatch",
    endpoint: "/api/v3/batches",
    response: { id: "batch_test", runCount: 1, isCached: false },
    scope: "read:batch:batch_test",
    expirationTime: "1h",
    invoke: (client: ApiClient, options?: ZodFetchOptions) =>
      client.createBatch({ runCount: 1 }, undefined, options),
  },
  {
    name: "createWaitpointToken",
    endpoint: "/api/v1/waitpoints/tokens",
    response: { id: "waitpoint_test", isCached: false, url: "https://example.com/waitpoint" },
    scope: "write:waitpoints:waitpoint_test",
    expirationTime: "24h",
    invoke: (client: ApiClient, options?: ZodFetchOptions) =>
      client.createWaitpointToken({}, options),
  },
];

// Catches: missing response tokens bypassing server minting or invoking resource hooks on tokens.
describe.each(cases)("$name public token response fallback", (scenario) => {
  let server: Server;
  let baseURL: string;
  let requests: { url?: string; authorization?: string; body: unknown }[];
  let tokenHeader: string | undefined;
  let mintStatus: number;

  beforeEach(async () => {
    requests = [];
    tokenHeader = undefined;
    mintStatus = 200;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString();
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });
      if (request.url === "/api/v1/auth/public-tokens") {
        response.writeHead(mintStatus, { "content-type": "application/json" });
        response.end(
          JSON.stringify(mintStatus === 200 ? { token: "minted-token" } : { error: "Denied" })
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        // Legacy claims must not be parsed or used for signing.
        "x-trigger-jwt-claims": "not-json",
        ...(tokenHeader ? { "x-trigger-jwt": tokenHeader } : {}),
      });
      response.end(JSON.stringify(scenario.response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("mints the same scope and expiration on the server for every credential type", async () => {
    for (const key of [
      "tr_prod_0123456789abcdefghijklmn",
      "tr_prod_sk_0123456789abcdefghijklmn",
      "eyJhbGciOiJSUzI1NiIsInR5cCI6InJ1bitqd3QifQ.eyJ0b2tlbl91c2UiOiJydW4ifQ.signature",
    ]) {
      requests = [];
      const observedBodies: unknown[] = [];
      const result = await scenario.invoke(new ApiClient(baseURL, key), {
        tracer: new TriggerTracer({ name: "public-token-fallback-test", version: "1" }),
        prepareData: (data) => {
          expect(data.id).toBe(scenario.response.id);
          return data;
        },
        onResponseBody: (body) => observedBodies.push(body),
      });
      expect(result).toMatchObject({ ...scenario.response, publicAccessToken: "minted-token" });
      expect(observedBodies).toEqual([scenario.response]);
      expect(requests.map(({ url }) => url)).toEqual([
        scenario.endpoint,
        "/api/v1/auth/public-tokens",
      ]);
      expect(requests[1]).toEqual({
        url: "/api/v1/auth/public-tokens",
        authorization: `Bearer ${key}`,
        body: { scopes: [scenario.scope], expirationTime: scenario.expirationTime },
      });
    }
  });

  it("uses the server response token without an additional mint request", async () => {
    tokenHeader = "header-token";
    const result = await scenario.invoke(new ApiClient(baseURL, "tr_prod_root"));
    expect(result.publicAccessToken).toBe("header-token");
    expect(requests.map(({ url }) => url)).toEqual([scenario.endpoint]);
  });

  it.each([401, 403, 404, 500])(
    "does not self-sign when server minting fails (%s)",
    async (status) => {
      mintStatus = status;
      const key =
        status === 404 ? "tr_prod_sk_0123456789abcdefghijklmn" : "tr_prod_0123456789abcdefghijklmn";
      const client = new ApiClient(baseURL, key, undefined, {
        retry: { maxAttempts: 1 },
      });
      const result = scenario.invoke(client);
      // Catches: callers retrying a successful mutation after its token mint fails.
      await expect(result).rejects.toThrow(
        `Resource ${scenario.response.id} was already created, but its public access token could not be minted. Do not blindly repeat the mutation.`
      );
      if (status === 404) {
        await expect(result).rejects.toThrow("Upgrade your self-hosted server");
      }
      await expect(result).rejects.toBeInstanceOf(ApiError);
      await expect(result).rejects.toMatchObject({ status });
      expect(requests.map(({ url }) => url)).toEqual([
        scenario.endpoint,
        "/api/v1/auth/public-tokens",
      ]);
    }
  );
});

// Catches: a Date passed to the response fallback changing from Unix seconds to milliseconds.
it("preserves custom expiration on response fallback tokens", async () => {
  const expiration = new Date("2030-01-01T00:00:00.999Z");
  let mintedBody: unknown;
  const server = createServer(async (request, response) => {
    if (request.url === "/api/v1/auth/public-tokens") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      mintedBody = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ token: "minted-token" }));
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "run_test" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new ApiClient(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      "tr_prod_root"
    );
    await client.triggerTask("task-one", {}, undefined, {
      publicAccessToken: { expirationTime: expiration },
    });
    expect(mintedBody).toEqual({ scopes: ["read:runs:run_test"], expirationTime: 1893456000 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
