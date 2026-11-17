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

// Catches: root credentials bypassing server authorization by signing public tokens locally.
describe.each([
  ["root", "tr_prod_0123456789abcdefghijklmn"],
  ["additional", "tr_prod_sk_0123456789abcdefghijklmn"],
])("public token minting with %s keys", (_label, key) => {
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

  it("uses server minting with Date expiration and realtime options", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken({
        scopes: { read: { runs: ["run_123"] } },
        expirationTime: new Date(expiresAt * 1000),
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
          expirationTime: expiresAt,
          realtime: { skipColumns: ["payload"] },
        },
      },
    ]);
  });

  it("server-mints trigger tokens with one-time-use semantics", async () => {
    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createTriggerPublicToken(["task-one", "task-two"], { multipleUse: true })
    );

    expect(requests[0]?.body).toEqual({
      scopes: ["trigger:tasks:task-one", "trigger:tasks:task-two"],
      oneTimeUse: false,
    });
  });

  it("server-mints batch trigger tokens", async () => {
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

  it.each(["", "   "])("rejects an explicitly empty resource ID", async (runId) => {
    const promise = apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken({ scopes: { read: { runs: [runId] } } })
    );

    await expect(promise).rejects.toThrow("Public token scope resource IDs must not be empty");
    expect(requests).toEqual([]);
  });

  it("preserves nonempty resource IDs exactly", async () => {
    await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken({ scopes: { read: { tags: [" env:staging "] } } })
    );

    expect(requests[0]?.body).toEqual({ scopes: ["read:tags: env:staging "] });
  });

  it.each([
    ["no options at all", undefined],
    ["an empty scopes object", {}],
    ["a scope group with nothing selected", { read: {} }],
  ])("server-mints zero-permission tokens with %s", async (_label, scopes) => {
    const token = await apiClientManager.runWithConfig({ baseURL: baseUrl, accessToken: key }, () =>
      auth.createPublicToken(scopes === undefined ? undefined : { scopes })
    );

    expect(token).toBe("server-minted-token");
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/v1/auth/public-tokens",
        authorization: `Bearer ${key}`,
        body: { scopes: [] },
      },
    ]);
  });

  // Catches: wrappers minting with or retaining the secret credential instead of the public token.
  it("scopes all three wrappers to the server-minted token and restores the caller", async () => {
    await auth.withAuth({ baseURL: baseUrl, accessToken: key }, async () => {
      const checkToken = async () => {
        expect(apiClientManager.clientOrThrow().getAccessToken("retrieveRun")).toBe(
          "server-minted-token"
        );
      };
      await auth.withPublicToken({ scopes: { read: { runs: true } } }, checkToken);
      await auth.withTriggerPublicToken("task-one", {}, checkToken);
      await auth.withBatchTriggerPublicToken("task-one", {}, checkToken);
      expect(apiClientManager.clientOrThrow().getAccessToken("retrieveRun")).toBe(key);
    });
    expect(requests.map(({ url, authorization }) => ({ url, authorization }))).toEqual(
      Array(3).fill({
        url: "/api/v1/auth/public-tokens",
        authorization: `Bearer ${key}`,
      })
    );
  });

  // Catches: authorization or server failures bypassed by retrying a local-signing path.
  it.each([401, 403, 500])(
    "propagates mint failures without local signing (%s)",
    async (status) => {
      publicTokenStatus = status;
      await auth.withAuth(
        {
          baseURL: baseUrl,
          accessToken: key,
          requestOptions: { retry: { maxAttempts: 1 } },
        },
        async () => {
          await expect(auth.createPublicToken()).rejects.toMatchObject({ status });
          await expect(auth.createTriggerPublicToken("task-one")).rejects.toMatchObject({ status });
          await expect(auth.createBatchTriggerPublicToken("task-one")).rejects.toMatchObject({
            status,
          });
        }
      );
      expect(requests.map(({ url }) => url)).toEqual(Array(3).fill("/api/v1/auth/public-tokens"));
    }
  );

  it("falls back only for root keys when the server lacks the mint endpoint", async () => {
    publicTokenStatus = 404;
    const promise = apiClientManager.runWithConfig(
      {
        baseURL: baseUrl,
        accessToken: key,
      },
      () => auth.createPublicToken({ scopes: { read: { runs: true } } })
    );

    if (_label === "root") {
      const validation = await validateJWT(await promise, key);
      expect(validation).toMatchObject({
        ok: true,
        payload: { sub: "env_test", pub: true, scopes: ["read:runs"] },
      });
      expect(requests.map(({ url }) => url)).toEqual([
        "/api/v1/auth/public-tokens",
        "/api/v1/auth/jwt/claims",
      ]);
    } else {
      await expect(promise).rejects.toThrow("Upgrade your self-hosted server");
      expect(requests.map(({ url }) => url)).toEqual(["/api/v1/auth/public-tokens"]);
    }
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

  if (request.url === "/api/v1/auth/public-tokens") {
    const status = publicTokenStatus();
    return json(
      response,
      status === 200 ? { token: "server-minted-token" } : { error: "Not found" },
      status
    );
  }

  if (request.url === "/api/v1/auth/jwt/claims") {
    return json(response, { sub: "env_test", pub: true });
  }

  return json(response, { error: "Not found" }, 404);
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
