import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager } from "@trigger.dev/core/v3";
import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "./auth.js";

type ReceivedRequest = {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
};

describe("public token API key routing", () => {
  let server: Server;
  let baseUrl: string;
  let requests: ReceivedRequest[];
  let publicTokenStatus: number;

  beforeEach(async () => {
    requests = [];
    publicTokenStatus = 200;
    server = createServer((request, response) => {
      void handleRequest(request, response, requests, () => publicTokenStatus);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uses server minting for additional keys", async () => {
    const key = "tr_prod_sk_0123456789abcdefghijklmn";
    const token = await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken({
        scopes: { read: { runs: ["run_123"] } },
        expirationTime: new Date("2030-01-01T00:00:00.000Z"),
        realtime: { skipColumns: ["payload"] },
      })
    );

    expect(token).toBe("server-minted-token");
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/v1/auth/public-tokens",
        authorization: `Bearer ${key}`,
        body: {
          scopes: ["read:runs:run_123"],
          expirationTime: 1893456000,
          realtime: { skipColumns: ["payload"] },
        },
      },
    ]);
  });

  it("server-mints trigger tokens with one-time-use semantics", async () => {
    const key = "tr_dev_sk_0123456789abcdefghijklmn";
    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createTriggerPublicToken(["task-one", "task-two"], { multipleUse: true })
    );

    expect(requests[0]?.body).toEqual({
      scopes: ["trigger:tasks:task-one", "trigger:tasks:task-two"],
      oneTimeUse: false,
    });
  });

  it("server-mints batch trigger tokens for additional keys", async () => {
    const key = "tr_stg_sk_0123456789abcdefghijklmn";
    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createBatchTriggerPublicToken("batch-task", {
        expirationTime: "2h",
        multipleUse: false,
        realtime: { skipColumns: ["payload"] },
      })
    );

    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/v1/auth/public-tokens",
        authorization: `Bearer ${key}`,
        body: {
          scopes: ["batchTrigger:tasks:batch-task"],
          expirationTime: "2h",
          oneTimeUse: true,
          realtime: { skipColumns: ["payload"] },
        },
      },
    ]);
  });

  it("keeps root key self-minting unchanged", async () => {
    const key = "tr_prod_0123456789abcdefghijklmn";
    const token = await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken({ scopes: { read: { runs: true } } })
    );

    expect(requests.map((request) => request.url)).toEqual(["/api/v1/auth/jwt/claims"]);
    const validation = await validateJWT(token, key);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.payload).toMatchObject({
      sub: "env_test",
      pub: true,
      scopes: ["read:runs"],
    });
  });

  it.each([
    ["no options at all", undefined],
    ["an empty scopes object", {}],
    ["a scope group with nothing selected", { read: {} }],
  ])("keeps root-key behavior unchanged for %s", async (_label, scopes) => {
    const key = "tr_prod_0123456789abcdefghijklmn";
    const token = await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken(scopes === undefined ? undefined : { scopes })
    );

    expect(requests.map((request) => request.url)).toEqual(["/api/v1/auth/jwt/claims"]);
    const validation = await validateJWT(token, key);
    expect(validation.ok).toBe(true);
  });

  it.each([
    ["no options at all", undefined],
    ["an empty scopes object", {}],
    ["a scope group with nothing selected", { read: {} }],
  ])("rejects %s clearly for additional keys", async (_label, scopes) => {
    const key = "tr_prod_sk_0123456789abcdefghijklmn";
    const promise = apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken(scopes === undefined ? undefined : { scopes })
    );

    await expect(promise).rejects.toThrow(
      "requires at least one scope when using an additional API key"
    );
    expect(requests).toEqual([]);
  });

  it("explains how to recover when the server lacks the mint endpoint", async () => {
    publicTokenStatus = 404;
    const promise = apiClientManager.runWithConfig(
      {
        baseURL: baseUrl,
        accessToken: "tr_prod_sk_0123456789abcdefghijklmn",
      },
      () => auth.createPublicToken({ scopes: { read: { runs: true } } })
    );

    await expect(promise).rejects.toThrow("Upgrade the server or use the root API key");
  });
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ReceivedRequest[],
  publicTokenStatus: () => number
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString();
  requests.push({
    method: request.method ?? "",
    url: request.url ?? "",
    authorization: request.headers.authorization,
    body: rawBody ? JSON.parse(rawBody) : undefined,
  });

  if (request.url === "/api/v1/auth/jwt/claims") {
    return json(response, { sub: "env_test", pub: true });
  }
  if (request.url === "/api/v1/auth/public-tokens") {
    const status = publicTokenStatus();
    return json(
      response,
      status === 200 ? { token: "server-minted-token" } : { error: "Not found" },
      status
    );
  }

  return json(response, { error: "Not found" }, 404);
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
