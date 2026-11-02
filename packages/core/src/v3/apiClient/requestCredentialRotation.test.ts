import { once } from "node:events";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { z } from "zod/v4";
import { afterEach, describe, expect, it } from "vitest";
import { apiClientManager } from "../apiClientManager-api.js";
import { runInMockTaskContext } from "../test/mock-task-context.js";
import { zodfetchCursorPage } from "./core.js";

const envNames = [
  "TRIGGER_API_URL",
  "TRIGGER_RUN_TOKEN",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_ACCESS_TOKEN",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  apiClientManager.disable();
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function runToken(runId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "run+jwt" })}.${encode({
    token_use: "run",
    aud: "trigger:api",
    exp: Math.floor(Date.now() / 1_000) + 3600,
    scopes: ["admin"],
    run_id: runId,
  })}.signature`;
}

describe("request credential rotation", () => {
  it("resolves credentials for HTTP retries and subsequent pages without mutating original headers", async () => {
    let accessToken = "initial";
    const requests: { authorization?: string; retained?: string; after: string | null }[] = [];
    const server = await serve((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        retained: request.headers["x-retained-header"] as string | undefined,
        after: new URL(request.url!, "http://localhost").searchParams.get("page[after]"),
      });
      response.setHeader("Content-Type", "application/json");
      if (requests.length === 1) {
        accessToken = "retry";
        response.writeHead(503).end(JSON.stringify({ error: "Retry" }));
      } else if (requests.length === 2) {
        response.end(JSON.stringify({ data: ["first"], pagination: { next: "cursor" } }));
      } else {
        response.end(JSON.stringify({ data: ["second"], pagination: {} }));
      }
    });
    const headers = new Headers({
      Authorization: "Bearer original",
      "x-retained-header": "retained",
    });
    try {
      const first = await zodfetchCursorPage(
        z.string(),
        server.url,
        {},
        { headers },
        {
          resolveAccessToken: () => accessToken,
          retry: {
            maxAttempts: 3,
            minTimeoutInMs: 1,
            maxTimeoutInMs: 1,
            factor: 1,
            randomize: false,
          },
        }
      );
      accessToken = "next-page";
      expect((await first.getNextPage()).data).toEqual(["second"]);
      expect(requests).toEqual([
        { authorization: "Bearer initial", retained: "retained", after: null },
        { authorization: "Bearer retry", retained: "retained", after: null },
        { authorization: "Bearer next-page", retained: "retained", after: "cursor" },
      ]);
      expect(headers.get("Authorization")).toBe("Bearer original");
    } finally {
      await server.close();
    }
  });

  it("keeps selection headers aligned with credentials across retries and pages", async () => {
    const token = runToken("run_initial");
    const requests: unknown[] = [];
    const server = await serve((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        operation: request.headers["x-trigger-sdk-operation"],
        reason: request.headers["x-trigger-sdk-credential-reason"],
      });
      response.setHeader("Content-Type", "application/json");
      if (requests.length === 1) {
        process.env.TRIGGER_RUN_TOKEN = token.replace(
          token.split(".")[1]!,
          Buffer.from(
            JSON.stringify({ token_use: "run", aud: "trigger:api", scopes: ["admin"], exp: 1 })
          ).toString("base64url")
        );
        response.writeHead(503).end(JSON.stringify({ error: "Retry" }));
      } else {
        response.end(
          JSON.stringify({
            data: ["value"],
            pagination: requests.length === 2 ? { next: "cursor" } : {},
          })
        );
      }
    });
    process.env.TRIGGER_API_URL = server.url;
    process.env.TRIGGER_RUN_TOKEN = token;
    process.env.TRIGGER_SECRET_KEY = "compatibility-key";
    delete process.env.TRIGGER_ACCESS_TOKEN;
    try {
      await runInMockTaskContext(async () => {
        const client = apiClientManager.clientOrThrow();
        const first = await zodfetchCursorPage(
          z.string(),
          server.url,
          {},
          {},
          {
            resolveHeaders: () => client.getAuthenticationHeaders("listRuns"),
            retry: {
              maxAttempts: 2,
              minTimeoutInMs: 1,
              maxTimeoutInMs: 1,
              factor: 1,
              randomize: false,
            },
          }
        );
        delete process.env.TRIGGER_RUN_TOKEN;
        expect((await first.getNextPage()).data).toEqual(["value"]);
        expect(requests).toEqual([
          { authorization: `Bearer ${token}`, operation: "listRuns", reason: "selected" },
          {
            authorization: "Bearer compatibility-key",
            operation: "listRuns",
            reason: "expired_token",
          },
          {
            authorization: "Bearer compatibility-key",
            operation: "listRuns",
            reason: "missing_token",
          },
        ]);
      });
    } finally {
      await server.close();
    }
  });

  it("uses the rotated implicit run token when an established SSE stream reconnects", async () => {
    const initialToken = runToken("run_initial");
    const rotatedToken = runToken("run_rotated");
    const authorizations: (string | undefined)[] = [];
    const telemetry: unknown[] = [];
    let firstResponse: ServerResponse | undefined;
    const server = await serve((request, response) => {
      authorizations.push(request.headers.authorization);
      telemetry.push({
        operation: request.headers["x-trigger-sdk-operation"],
        reason: request.headers["x-trigger-sdk-credential-reason"],
      });
      response.writeHead(200, { "Content-Type": "text/event-stream", "X-Stream-Version": "v1" });
      response.write(
        `id: ${authorizations.length}\ndata: ${JSON.stringify({ attempt: authorizations.length })}\n\n`
      );
      if (authorizations.length === 1) firstResponse = response;
    });
    const abort = new AbortController();
    process.env.TRIGGER_API_URL = server.url;
    process.env.TRIGGER_RUN_TOKEN = initialToken;
    process.env.TRIGGER_SECRET_KEY = "compatibility-key";
    delete process.env.TRIGGER_ACCESS_TOKEN;
    apiClientManager.disable();
    try {
      await runInMockTaskContext(async () => {
        const client = apiClientManager.clientOrThrow();
        const stream = await client.fetchStream<{ attempt: number }>("run_test", "records", {
          signal: abort.signal,
        });
        const reader = stream.getReader();
        try {
          expect(await reader.read()).toMatchObject({ done: false, value: { attempt: 1 } });
          process.env.TRIGGER_RUN_TOKEN = rotatedToken;
          firstResponse!.destroy();
          expect(await reader.read()).toMatchObject({ done: false, value: { attempt: 2 } });
          expect(authorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${rotatedToken}`]);
          expect(telemetry).toEqual(
            Array(2).fill({ operation: "fetchStream", reason: "selected" })
          );
        } finally {
          abort.abort();
          await reader.cancel();
        }
      });
    } finally {
      abort.abort();
      await server.close();
    }
  });
});
