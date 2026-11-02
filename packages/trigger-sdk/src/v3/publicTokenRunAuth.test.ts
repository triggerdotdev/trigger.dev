import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { apiClientManager } from "@trigger.dev/core/v3";
import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chat } from "./ai.js";
import { auth } from "./auth.js";
import { AgentChat } from "./chat-client.js";

const ROOT_KEY = "tr_prod_0123456789abcdefghijklmn";
const ADDITIONAL_KEY = "tr_prod_sk_0123456789abcdefghijklmn";
const RUN_TOKEN = [
  { alg: "RS256", typ: "run+jwt" },
  {
    sub: "run_parent",
    token_use: "run",
    aud: "trigger:api",
    scopes: ["admin"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
  .concat("signature")
  .join(".");
const ENV_KEYS = [
  "TRIGGER_API_URL",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_ACCESS_TOKEN",
  "TRIGGER_RUN_TOKEN",
] as const;

type ReceivedRequest = {
  url: string;
  authorization?: string;
  body: unknown;
};

describe("public token minting with run credentials", () => {
  let server: Server;
  let baseURL: string;
  let requests: ReceivedRequest[];
  let publicTokenStatus: number;
  let reconnectToken: string | undefined;
  let disconnectStream: boolean;
  let streamStatus: number;
  let streamRequests: { authorization?: string; operation?: string; reason?: string }[];
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    apiClientManager.disable();
    requests = [];
    publicTokenStatus = 200;
    reconnectToken = undefined;
    disconnectStream = false;
    streamStatus = 200;
    streamRequests = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString();
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });

      let status = 200;
      let body: unknown;
      switch (request.url) {
        case "/api/v1/auth/public-tokens":
          status = publicTokenStatus;
          body = status === 200 ? { token: "server-minted-token" } : { error: "Not found" };
          break;
        case "/api/v1/auth/jwt/claims":
          body = { sub: "env_test", pub: true };
          break;
        case "/api/v1/sessions":
          body = {
            id: "session_test",
            externalId: "chat-test",
            type: "chat.agent",
            taskIdentifier: "chat-task",
            runId: "run_chat",
            publicAccessToken: "session-token",
            tags: [],
            metadata: null,
            closedAt: null,
            closedReason: null,
            expiresAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isCached: false,
          };
          break;
        case "/realtime/v1/sessions/chat-test/in/append":
          body = { ok: true };
          break;
        case "/realtime/v1/sessions/chat-test/out":
          streamRequests.push({
            authorization: request.headers.authorization,
            operation: request.headers["x-trigger-sdk-operation"] as string | undefined,
            reason: request.headers["x-trigger-sdk-credential-reason"] as string | undefined,
          });
          if (streamStatus !== 200) {
            response.writeHead(streamStatus).end();
            return;
          }
          if (reconnectToken && streamRequests.length === 1) {
            process.env.TRIGGER_RUN_TOKEN = reconnectToken;
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "x-stream-version": "v2",
            });
            response.write(
              `event: batch\ndata: ${JSON.stringify({ records: [{ body: JSON.stringify({ type: "text-start", id: "part-1" }), seq_num: 1, timestamp: Date.now() }] })}\n\n`
            );
            if (disconnectStream) setTimeout(() => response.destroy(), 10);
            else response.end();
            return;
          }
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "x-stream-version": "v2",
          });
          response.end(
            `event: batch\ndata: ${JSON.stringify({
              records: [
                {
                  body: "",
                  seq_num: 2,
                  timestamp: Date.now(),
                  headers: [["trigger-control", "turn-complete"]],
                },
              ],
            })}\n\n`
          );
          return;
        default:
          status = 404;
          body = { error: "Not found" };
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.TRIGGER_API_URL = baseURL;
    process.env.TRIGGER_SECRET_KEY = ROOT_KEY;
    delete process.env.TRIGGER_ACCESS_TOKEN;
    process.env.TRIGGER_RUN_TOKEN = RUN_TOKEN;
  });

  afterEach(async () => {
    apiClientManager.disable();
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("server-mints public, trigger and batch tokens without a secret key", async () =>
    runInMockTaskContext(async () => {
      delete process.env.TRIGGER_SECRET_KEY;
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const tokens = [
        await auth.createPublicToken({
          scopes: { read: { runs: "run_child" } },
          expirationTime: new Date(expiresAt * 1000),
          realtime: { skipColumns: ["payload"] },
        }),
        await auth.createTriggerPublicToken(["task-one", "task-two"], {
          expirationTime: "2h",
          multipleUse: true,
        }),
        await auth.createBatchTriggerPublicToken("batch-task", {
          expirationTime: expiresAt,
          realtime: { skipColumns: ["output"] },
        }),
      ];

      expect(tokens).toEqual(Array(3).fill("server-minted-token"));
      expect(requests).toEqual(
        [
          {
            scopes: ["read:runs:run_child"],
            expirationTime: expiresAt,
            realtime: { skipColumns: ["payload"] },
          },
          {
            scopes: ["trigger:tasks:task-one", "trigger:tasks:task-two"],
            expirationTime: "2h",
            oneTimeUse: false,
          },
          {
            scopes: ["batchTrigger:tasks:batch-task"],
            expirationTime: expiresAt,
            oneTimeUse: true,
            realtime: { skipColumns: ["output"] },
          },
        ].map((body) => ({
          url: "/api/v1/auth/public-tokens",
          authorization: `Bearer ${RUN_TOKEN}`,
          body,
        }))
      );
    }));

  it("keeps explicit root-key signing for all three helpers despite a default run token", async () =>
    runInMockTaskContext(async () => {
      const tokens = await auth.withAuth({ accessToken: ROOT_KEY }, async () => [
        await auth.createPublicToken({ scopes: { read: { runs: true } } }),
        await auth.createTriggerPublicToken("task-one"),
        await auth.createBatchTriggerPublicToken("task-one", { multipleUse: true }),
      ]);

      expect(requests.map(({ url, authorization }) => ({ url, authorization }))).toEqual(
        tokens.map(() => ({
          url: "/api/v1/auth/jwt/claims",
          authorization: `Bearer ${ROOT_KEY}`,
        }))
      );
      for (const token of tokens) {
        expect(await validateJWT(token, ROOT_KEY)).toMatchObject({
          ok: true,
          payload: { sub: "env_test", pub: true },
        });
      }
    }));

  it("preserves explicit additional-key server minting despite a default run token", async () =>
    runInMockTaskContext(async () => {
      await auth.withAuth({ accessToken: ADDITIONAL_KEY }, () =>
        auth.createPublicToken({ scopes: { read: { runs: "run_child" } } })
      );
      expect(requests).toEqual([
        {
          url: "/api/v1/auth/public-tokens",
          authorization: `Bearer ${ADDITIONAL_KEY}`,
          body: { scopes: ["read:runs:run_child"] },
        },
      ]);
    }));

  it.each([
    ["missing scopes", undefined],
    ["empty scopes", {}],
    ["an empty scope group", { read: {} }],
  ])(
    "preserves root signing and no permissions for %s despite a default run token",
    async (_label, scopes) =>
      runInMockTaskContext(async () => {
        const token = await auth.createPublicToken(scopes === undefined ? undefined : { scopes });
        expect(requests).toEqual([
          {
            url: "/api/v1/auth/jwt/claims",
            authorization: `Bearer ${ROOT_KEY}`,
            body: undefined,
          },
        ]);
        const validation = await validateJWT(token, ROOT_KEY);
        expect(validation.ok).toBe(true);
        if (!validation.ok) return;
        expect(validation.payload.scopes).toEqual(scopes === undefined ? undefined : []);
      })
  );

  it("lets an explicit root key sign public tokens longer than 30 days locally", async () =>
    runInMockTaskContext(async () => {
      const token = await auth.withAuth({ accessToken: ROOT_KEY }, () =>
        auth.createPublicToken({ scopes: { read: { runs: "run_child" } }, expirationTime: "90d" })
      );
      const { exp } = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
      expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(89 * 24 * 60 * 60);
      expect(requests.map((request) => request.url)).toEqual(["/api/v1/auth/jwt/claims"]);
    }));

  it("requires scopes with an explicit run token rather than signing with it", async () =>
    runInMockTaskContext(async () => {
      await expect(
        auth.withAuth({ accessToken: RUN_TOKEN }, () => auth.createPublicToken())
      ).rejects.toThrow("requires at least one scope when using a run token");
      expect(requests).toEqual([]);
    }));

  it("does not fall back to local signing when server minting is unavailable", async () =>
    runInMockTaskContext(async () => {
      publicTokenStatus = 404;
      await expect(
        auth.createPublicToken({ scopes: { read: { runs: "run_child" } } })
      ).rejects.toThrow("This run token cannot self-sign public tokens");
      expect(requests.map(({ url }) => url)).toEqual(["/api/v1/auth/public-tokens"]);
    }));

  it.each([
    ["default run token", undefined, RUN_TOKEN],
    ["explicit root key", ROOT_KEY, ROOT_KEY],
    ["explicit additional key", ADDITIONAL_KEY, ADDITIONAL_KEY],
  ])("routes AgentChat append and SSE with %s", async (_label, explicitKey, key) =>
    runInMockTaskContext(async () => {
      await auth.withAuth(explicitKey ? { accessToken: explicitKey } : {}, async () => {
        const client = new AgentChat({ agent: "chat-task", id: "chat-test", baseURL });
        const stream = await client.sendMessage("hello");
        expect(await stream.text()).toBe("");
      });

      expect(requests.slice(1).map(({ url, authorization }) => ({ url, authorization }))).toEqual([
        {
          url: "/realtime/v1/sessions/chat-test/in/append",
          authorization: `Bearer ${key}`,
        },
        {
          url: "/realtime/v1/sessions/chat-test/out",
          authorization: `Bearer ${key}`,
        },
      ]);
    })
  );

  it.each(["replacement", "expiry", "explicit", "network"] as const)(
    "resolves AgentChat credentials and telemetry per reconnection (%s)",
    async (mode) =>
      runInMockTaskContext(async () => {
        disconnectStream = mode === "network";
        const [header, payload] = RUN_TOKEN.split(".");
        reconnectToken =
          mode === "expiry"
            ? `${header}.${Buffer.from(JSON.stringify({ token_use: "run", aud: "trigger:api", scopes: ["admin"], exp: 1 })).toString("base64url")}.signature`
            : `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), jti: "replacement" })).toString("base64url")}.signature`;
        await auth.withAuth(mode === "explicit" ? { accessToken: ROOT_KEY } : {}, async () => {
          const client = new AgentChat({ agent: "chat-task", id: "chat-test", baseURL });
          const stream = await client.sendMessage("hello");
          await stream.text();
        });
        expect(streamRequests).toEqual(
          mode === "explicit"
            ? [{ authorization: `Bearer ${ROOT_KEY}` }, { authorization: `Bearer ${ROOT_KEY}` }]
            : [
                {
                  authorization: `Bearer ${RUN_TOKEN}`,
                  operation: "subscribeToSessionStream",
                  reason: "selected",
                },
                {
                  authorization: `Bearer ${mode === "expiry" ? ROOT_KEY : reconnectToken}`,
                  operation: "subscribeToSessionStream",
                  reason: mode === "expiry" ? "expired_token" : "selected",
                },
              ]
        );
      })
  );

  it.each([401, 403])("does not escalate AgentChat auth failures (%s)", async (code) =>
    runInMockTaskContext(async () => {
      streamStatus = code;
      const client = new AgentChat({ agent: "chat-task", id: "chat-test", baseURL });
      const stream = await client.sendMessage("hello");
      await expect(stream.text()).rejects.toThrow();
      expect(streamRequests.map((request) => request.authorization)).toEqual([
        `Bearer ${RUN_TOKEN}`,
      ]);
    })
  );

  it.each([
    ["default run token", undefined, RUN_TOKEN, "/api/v1/auth/public-tokens"],
    ["explicit root key", ROOT_KEY, ROOT_KEY, "/api/v1/auth/jwt/claims"],
    ["explicit additional key", ADDITIONAL_KEY, ADDITIONAL_KEY, "/api/v1/auth/public-tokens"],
  ])("routes direct chat-start minting with %s", async (_label, explicitKey, key, endpoint) =>
    runInMockTaskContext(async () => {
      const start = chat.createStartSessionAction("chat-task", {
        baseURL,
        tokenTTL: "2h",
        ...(explicitKey ? { apiClient: { accessToken: explicitKey } } : {}),
      });
      const result = await start({ chatId: "chat-test" });

      expect(requests.map(({ url }) => url)).toEqual(["/api/v1/sessions", endpoint]);
      expect(requests[1]?.authorization).toBe(`Bearer ${key}`);
      if (explicitKey === ROOT_KEY) {
        expect(await validateJWT(result.publicAccessToken, ROOT_KEY)).toMatchObject({
          ok: true,
          payload: {
            scopes: ["read:sessions:chat-test", "write:sessions:chat-test"],
          },
        });
      } else {
        expect(result.publicAccessToken).toBe("server-minted-token");
        expect(requests[1]?.body).toEqual({
          scopes: ["read:sessions:chat-test", "write:sessions:chat-test"],
          expirationTime: "2h",
        });
      }
    })
  );
});
