import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { apiClientManager } from "../apiClientManager-api.js";
import { runInMockTaskContext } from "../test/mock-task-context.js";
import { sdkScope } from "../sdkScope/index.js";
import "../sdkScope/storage-node.js";

const envNames = [
  "TRIGGER_RUN_TOKEN",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_ACCESS_TOKEN",
  "TRIGGER_API_URL",
] as const;
const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const key = "tr_dev_compatibility";

function token(exp = Math.floor(Date.now() / 1_000) + 3600, run = "run_first") {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "run+jwt" })}.${encode({ token_use: "run", aud: "trigger:api", exp, scopes: ["admin"], run_id: run })}.signature`;
}

afterEach(() => {
  apiClientManager.disable();
  for (const name of envNames) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

async function serverFor(status = 200) {
  const requests: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        status === 200 ? { token: "server-signed-public-token" } : { error: "Invalid run token" }
      )
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  process.env.TRIGGER_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.TRIGGER_SECRET_KEY = key;
  delete process.env.TRIGGER_ACCESS_TOKEN;
  apiClientManager.disable();
  return {
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

describe("in-run client credentials", () => {
  it("keeps the public accessToken property on the configured key while operations select run tokens", async () =>
    runInMockTaskContext(async () => {
      process.env.TRIGGER_API_URL = "http://127.0.0.1:1";
      process.env.TRIGGER_SECRET_KEY = key;
      process.env.TRIGGER_RUN_TOKEN = token();
      const client = apiClientManager.clientOrThrow();
      expect(client.accessToken).toBe(key);
      expect(client.getAccessToken("retrieveRun")).toBe(process.env.TRIGGER_RUN_TOKEN);

      delete process.env.TRIGGER_SECRET_KEY;
      expect(apiClientManager.clientOrThrow().accessToken).toBe(process.env.TRIGGER_RUN_TOKEN);
    }));

  it("retains a client across requests but selects the current attempt token and expiry fallback", async () => {
    const server = await serverFor();
    try {
      const client = apiClientManager.clientOrThrow();
      await runInMockTaskContext(async () => {
        process.env.TRIGGER_RUN_TOKEN = token();
        await client.createPublicToken({ scopes: ["read:runs"] });
        expect(server.requests.at(-1)?.authorization).toBe(
          `Bearer ${process.env.TRIGGER_RUN_TOKEN}`
        );
        process.env.TRIGGER_RUN_TOKEN = token(undefined, "run_second");
        await client.createPublicToken({ scopes: ["read:runs"] });
        expect(server.requests.at(-1)?.authorization).toBe(
          `Bearer ${process.env.TRIGGER_RUN_TOKEN}`
        );
        expect(client.getHeaders("listSchedules").Authorization).toBe(`Bearer ${key}`);
        process.env.TRIGGER_RUN_TOKEN = token(1);
        await client.createPublicToken({ scopes: ["read:runs"] });
        expect(server.requests.at(-1)?.authorization).toBe(`Bearer ${key}`);
      });
      expect(server.requests).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it("preserves explicit global/client/scoped credentials while base-URL-only config stays dynamic", async () => {
    const server = await serverFor();
    try {
      await runInMockTaskContext(async () => {
        process.env.TRIGGER_RUN_TOKEN = token();
        const retained = apiClientManager.clientOrThrow();
        apiClientManager.setGlobalAPIClientConfiguration({ accessToken: "explicit-global" });
        expect(apiClientManager.clientOrThrow().getAccessToken("retrieveRun")).toBe(
          "explicit-global"
        );
        expect(
          apiClientManager
            .clientOrThrow({ accessToken: "explicit-client" })
            .getAccessToken("retrieveRun")
        ).toBe("explicit-client");
        apiClientManager.disable();
        await apiClientManager.runWithConfig({ accessToken: "explicit-scoped" }, async () => {
          expect(retained.getAccessToken("retrieveRun")).toBe("explicit-scoped");
        });
        await apiClientManager.runWithConfig({ baseURL: process.env.TRIGGER_API_URL }, async () => {
          expect(apiClientManager.clientOrThrow().getAccessToken("retrieveRun")).toBe(
            process.env.TRIGGER_RUN_TOKEN
          );
        });
        sdkScope.withScope({ apiClientConfig: {}, inheritContext: false }, () => {
          expect(retained.getAccessToken("retrieveRun")).toBe(key);
        });
      });
    } finally {
      await server.close();
    }
  });

  it("supports run-token-only defaults but fails unsupported operations without a key", async () => {
    const server = await serverFor();
    try {
      delete process.env.TRIGGER_SECRET_KEY;
      process.env.TRIGGER_RUN_TOKEN = token();
      await runInMockTaskContext(async () => {
        const client = apiClientManager.clientOrThrow();
        await client.createPublicToken({ scopes: ["read:runs"] });
        expect(server.requests[0]?.authorization).toBe(`Bearer ${process.env.TRIGGER_RUN_TOKEN}`);
        expect(() => client.getAccessToken("listSchedules")).toThrow("No API credential available");
      });
    } finally {
      await server.close();
    }
  });

  it("never retries rejected run tokens with the environment key", async () => {
    const server = await serverFor(401);
    try {
      process.env.TRIGGER_RUN_TOKEN = token();
      await runInMockTaskContext(async () => {
        await expect(
          apiClientManager.clientOrThrow().createPublicToken({ scopes: ["read:runs"] })
        ).rejects.toThrow();
      });
      expect(server.requests).toEqual([
        {
          path: "/api/v1/auth/public-tokens",
          authorization: `Bearer ${process.env.TRIGGER_RUN_TOKEN}`,
        },
      ]);
    } finally {
      await server.close();
    }
  });
});
