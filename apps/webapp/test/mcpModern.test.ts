import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import plugin from "@trigger.dev/rbac";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
}));

vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));
vi.mock("~/v3/webhookEngine.server", () => ({ webhookEngine: {} }));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) =>
          mocks.rbac[prop](...args),
    }
  ),
}));

import {
  call,
  capture,
  checkGolden,
  normalize,
  rpc,
  seed as seedData,
  withServer,
} from "./fixtures/mcpHarness";

const MODERN = "2026-07-28";
const GOLDEN_DIR = join(__dirname, "fixtures/mcp-golden");
const MODERN_DIR = join(GOLDEN_DIR, MODERN);

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true }) as any;
  return seedData(prisma);
}

const envelope = (version = MODERN) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "golden", version: "1.0.0" },
});

const modernRpc = (
  id: number,
  method: string,
  params: { name?: string; arguments?: unknown; notifications?: unknown } = {}
) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope() } });

function headersFor(body: { method: string; params: { name?: string } }) {
  return {
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": body.method,
    ...(body.params?.name ? { "Mcp-Name": body.params.name } : {}),
  };
}

const legacyFixture = (name: string): any =>
  (JSON.parse(readFileSync(join(GOLDEN_DIR, "2025-11-25", `${name}.json`), "utf8")) as any)
    .response;

describe("MCP protocol 2026-07-28", () => {
  // Catches: every request routed through the legacy transport, or cacheHints/resultType dropped.
  postgresTest(
    "responses match the fixtures and the 2025-11-25 transcripts",
    async ({ prisma }) => {
      const { token, known } = await seed(prisma);

      await withServer(prisma, async (baseUrl) => {
        const cases = [
          { name: "discover", request: modernRpc(1, "server/discover") },
          { name: "tools-list", request: modernRpc(2, "tools/list") },
          {
            name: "call-list-projects",
            request: modernRpc(3, "tools/call", { name: "list_projects", arguments: {} }),
          },
        ];
        const responses: Record<string, any> = {};
        for (const { name, request } of cases) {
          const response = await capture(
            await fetch(`${baseUrl}/mcp`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${token}`,
                ...headersFor(request),
              },
              body: JSON.stringify(request),
            })
          );
          const normalized = normalize({ request, response }, known) as { response: any };
          checkGolden(MODERN_DIR, name, normalized);
          responses[name] = normalized.response;
        }

        const discover = responses["discover"].body.result;
        expect(discover.capabilities.tools).toBeDefined();
        expect(discover._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
          name: "trigger.dev",
          version: "1.0.0",
        });

        const list = responses["tools-list"].body.result;
        expect(list).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
        const pick = (t: any) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        });
        expect(list.tools.map(pick)).toEqual(
          legacyFixture("tools-list").body.result.tools.map(pick)
        );

        const callResult = responses["call-list-projects"].body.result;
        expect(callResult.resultType).toBe("complete");
        expect(callResult.content).toEqual(legacyFixture("call-list-projects").body.result.content);
      });
    }
  );

  // Catches: createMcpHandler placed ahead of the bearer layer, or isLegacyRequest routing dropped.
  postgresTest(
    "enforces the 2026 ladder behind our bearer auth and still serves 2025",
    async ({ prisma }) => {
      const { token, known, otherProjectRef } = await seed(prisma);
      const crossTenant = modernRpc(4, "tools/call", {
        name: "list_runs",
        arguments: { projectRef: otherProjectRef, environment: "prod" },
      });
      const listTools = modernRpc(5, "tools/list");
      const legacyInit = rpc(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "golden", version: "1.0.0" },
      });
      const unsupported = rpc(6, "tools/list", { _meta: envelope("2099-01-01") });

      await withServer(prisma, async (baseUrl) => {
        const post = (body: unknown, headers: Record<string, string>, auth = true) =>
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(auth ? { Authorization: `Bearer ${token}` } : {}),
              ...headers,
            },
            body: JSON.stringify(body),
          });

        const denied = await capture(await post(crossTenant, headersFor(crossTenant)));
        expect(denied.status).toBe(200);
        expect((normalize(denied.body, known) as any).result.content).toEqual(
          legacyFixture("error-cross-tenant-project").body.result.content
        );
        expect((denied.body as any).result.isError).toBe(true);

        const cases = [
          {
            name: "Mcp-Method mismatch",
            send: () => post(listTools, { ...headersFor(listTools), "Mcp-Method": "tools/call" }),
            status: 400,
            code: -32020,
          },
          {
            name: "missing standard headers",
            send: () => post(listTools, {}),
            status: 400,
            code: -32020,
          },
          {
            name: "unsupported version",
            send: () =>
              post(unsupported, {
                "MCP-Protocol-Version": "2099-01-01",
                "Mcp-Method": "tools/list",
              }),
            status: 400,
            code: -32022,
          },
        ];
        for (const { name, send, status, code } of cases) {
          const res = await capture(await send());
          expect({ name, status: res.status, code: (res.body as any).error?.code }).toEqual({
            name,
            status,
            code,
          });
        }

        const unauthenticated = await capture(await post(listTools, headersFor(listTools), false));
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers["www-authenticate"]).toContain("resource_metadata=");

        const init = await capture(await post(legacyInit, {}));
        expect(normalize(init, known)).toEqual(legacyFixture("initialize"));
      });
    }
  );

  // Catches: the subscriptions/listen guard dropped, or the server built from a per-router ctx.
  postgresTest("answers listen with JSON and keeps identities apart", async ({ prisma }) => {
    const { token, otherToken, orgIds } = await seed(prisma);
    const listen = modernRpc(7, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    const listProjects = modernRpc(8, "tools/call", { name: "list_projects", arguments: {} });

    await withServer(prisma, async (baseUrl) => {
      const post = (body: typeof listen, pat: string) =>
        fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${pat}`,
            ...headersFor(body),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        });

      const listened = await capture(await post(listen, token));
      expect(listened.headers["content-type"]).toContain("application/json");
      expect((listened.body as any).error.code).toBe(-32601);

      const pats = [token, otherToken, token, otherToken];
      const texts = await Promise.all(
        pats.map(async (pat) => {
          const res = await capture(await post(listProjects, pat));
          return (res.body as any).result.content[0].text as string;
        })
      );
      texts.forEach((text, i) => {
        const [own, other] = pats[i] === token ? orgIds : [orgIds[1], orgIds[0]];
        expect(text).toContain(own);
        expect(text).not.toContain(other);
      });
    });
  });

  // Catches: the legacy era reaching its transport for listen, or a transport given a sessionIdGenerator.
  postgresTest("refuses legacy-shaped listen and never issues a session id", async ({ prisma }) => {
    const { token } = await seed(prisma);
    const legacyInit = rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "golden", version: "1.0.0" },
    });
    const modernList = modernRpc(2, "tools/list");
    const modernCall = modernRpc(3, "tools/call", { name: "list_projects", arguments: {} });
    const legacyList = rpc(4, "tools/list");
    const legacyCall = call(5, "list_projects");
    const legacyListen = rpc(6, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });

    await withServer(prisma, async (baseUrl) => {
      const post = (body: { method: string }, extra: Record<string, string> = {}) =>
        fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
            ...extra,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        });

      const listened = await post(legacyListen);
      expect(listened.headers.get("content-type")).toContain("application/json");
      expect(((await listened.json()) as any).error.code).toBe(-32601);

      const requests = [
        { name: "legacy initialize", send: () => post(legacyInit) },
        { name: "legacy tools/list", send: () => post(legacyList) },
        { name: "legacy tools/call", send: () => post(legacyCall) },
        { name: "modern tools/list", send: () => post(modernList, headersFor(modernList)) },
        { name: "modern tools/call", send: () => post(modernCall, headersFor(modernCall)) },
      ];
      for (const { name, send } of requests) {
        const res = await send();
        await res.text();
        expect({ name, status: res.status, session: res.headers.get("mcp-session-id") }).toEqual({
          name,
          status: 200,
          session: null,
        });
      }
    });
  });

  // Catches: the rate limiter running after express.json or before bearer auth.
  postgresTest("runs bearer auth, then the rate limiter, then body parsing", async ({ prisma }) => {
    const { token } = await seed(prisma);
    let reached = 0;
    const limiter = (_req: unknown, res: any) => {
      reached++;
      res.status(429).json({ error: "rate limited" });
    };

    await withServer(
      prisma,
      async (baseUrl) => {
        const post = (auth: boolean) =>
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(auth ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: "{not json",
            signal: AbortSignal.timeout(5_000),
          });

        const anonymous = await post(false);
        expect(anonymous.status).toBe(401);
        expect(reached).toBe(0);

        const authenticated = await post(true);
        expect(authenticated.status).toBe(429);
        expect(reached).toBe(1);
      },
      limiter
    );
  });
});
