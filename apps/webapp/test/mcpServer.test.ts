import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import plugin, { signUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, vi } from "vitest";
import { createMcpBearerAuthenticator } from "~/mcp/auth/bearer.server";
import { createMcpProtectedResourceHandler } from "~/mcp/protectedResource.server";
import { mcpTools, type McpToolDefinition } from "~/mcp/registry.server";
import { createMcpRouter } from "~/mcp/server.server";

vi.setConfig({ testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: mocks.info },
}));

const ORIGIN = "https://mcp.test";
const PRM_PATH = "/.well-known/oauth-protected-resource";
const SECRET = "test-secret";
const AUDIENCE = `${ORIGIN}/mcp`;

type TestServer = { baseUrl: string; origin: string; limited: string[]; touched: string[] };

async function withServer(
  prisma: PrismaClient,
  fn: (server: TestServer) => Promise<void>,
  tools?: McpToolDefinition[],
  allowedOrigin?: string | ((origin: string) => string)
) {
  const limited: string[] = [];
  const touched: string[] = [];
  const app = express();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.get(
    PRM_PATH,
    createMcpProtectedResourceHandler({
      origin: ORIGIN,
      authorizationServers: [],
      scopes: ["read:runs"],
    })
  );
  app.use(
    "/mcp",
    createMcpRouter({
      allowedOrigin:
        typeof allowedOrigin === "function" ? allowedOrigin(origin) : (allowedOrigin ?? origin),
      authenticate: createMcpBearerAuthenticator({
        rbac: plugin.create(prisma, { forceFallback: true, userActorSecret: SECRET }),
        failureBody: (failure) => ({ error: failure.error, code: failure.code }),
        // The source-PAT liveness check of resolveAndRecheckUserActorClaims, minus env.
        recheckUserActorClaims: async (claims, bearer, audience) => {
          const resolved = (await verifyUserActorToken(SECRET, bearer, { audience })) ?? claims;
          if (!resolved?.pat) return resolved;
          const live = await prisma.personalAccessToken.findFirst({
            where: { id: resolved.pat, revokedAt: null },
          });
          return live ? resolved : undefined;
        },
        touchPat: async (tokenId) => {
          touched.push(tokenId);
        },
        resourceMetadataUrl: `${ORIGIN}${PRM_PATH}`,
        audience: AUDIENCE,
      }),
      tools,
      rateLimit: (req, _res, next) => {
        limited.push(req.headers.authorization ?? "");
        next();
      },
    })
  );
  try {
    await fn({ baseUrl: origin, origin, limited, touched });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seedPat(prisma: PrismaClient, expiresAt: Date | null) {
  const user = await prisma.user.create({
    data: {
      email: `${randomBytes(6).toString("hex")}@test.dev`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  const token = `tr_pat_${randomBytes(20).toString("hex")}`;
  const pat = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      userId: user.id,
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(token).digest("hex"),
      expiresAt,
    },
  });
  return { token, tokenId: pat.id, userId: user.id };
}

function postMcp(
  baseUrl: string,
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {}
) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectRegisteredTools(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("mcp-session-id")).toBeNull();
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools).toHaveLength(mcpTools.length);
  expect(body.result.tools.map((t) => t.name).sort()).toEqual(mcpTools.map((t) => t.name).sort());
}

const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("MCP server", () => {
  // Mutation: drop the Host check, or run it after auth.
  postgresTest("a foreign Host is 404 before auth runs", async ({ prisma }) => {
    await withServer(
      prisma,
      async ({ baseUrl, limited }) => {
        const res = await postMcp(baseUrl, toolsList);
        expect(res.status).toBe(404);
        expect(limited).toEqual([]);
      },
      undefined,
      ORIGIN
    );
  });

  // Mutation: mount the guard on the whole router instead of the endpoint.
  postgresTest("the guard leaves /mcp/confirm paths to the next handler", async ({ prisma }) => {
    await withServer(
      prisma,
      async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/mcp/confirm/x`);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain("Cannot GET");
      },
      undefined,
      ORIGIN
    );
  });

  // Mutation: compare Origin to the raw configured string.
  postgresTest("Origin match normalises the configured origin", async ({ prisma }) => {
    await withServer(
      prisma,
      async ({ baseUrl }) => {
        const url = baseUrl.replace("127.0.0.1", "localhost");
        const res = await postMcp(url, toolsList, undefined, { Origin: url });
        expect(res.status).toBe(401);
      },
      undefined,
      (origin) => `${origin.replace("127.0.0.1", "LOCALHOST")}/`
    );
  });

  // Mutation: reject an absent Origin, skip the Origin check, or accept any Origin.
  postgresTest.for([
    ["no Origin", undefined, 401],
    ["the MCP origin", "own", 401],
    ["a foreign Origin", "https://evil.test", 403],
  ] as const)("Origin %s is gated without CORS headers", async ([, origin, status], { prisma }) => {
    await withServer(prisma, async (server) => {
      const headers = origin ? { Origin: origin === "own" ? server.origin : origin } : undefined;
      const res = await postMcp(server.baseUrl, toolsList, undefined, headers);
      expect(res.status).toBe(status);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // Mutation: drop WWW-Authenticate, rate limit before auth, or parse the body before auth.
  postgresTest.for([
    ["valid JSON", toolsList],
    ["invalid JSON", "{not json"],
  ])("no bearer with %s gets 401 with resource metadata", async ([, body], { prisma }) => {
    await withServer(prisma, async ({ baseUrl, limited }) => {
      const res = await postMcp(baseUrl, body);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${ORIGIN}${PRM_PATH}"`
      );
      expect(limited).toEqual([]);
    });
  });

  // Mutation: accept any bearer.
  postgresTest("garbage token gets 401", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      expect((await postMcp(baseUrl, toolsList, "tr_pat_garbage")).status).toBe(401);
    });
  });

  // Mutation: skip the expiry check or drop the failure body.
  postgresTest("expired PAT gets 401 with the expiry code", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const { token } = await seedPat(prisma, new Date(Date.now() - 60_000));
      const res = await postMcp(baseUrl, toolsList, token);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBeTruthy();
    });
  });

  // Mutation: reject valid PATs, use a stateful or SSE transport, skip the limiter or lastAccessedAt.
  postgresTest("valid PAT lists the registered tools", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl, limited, touched }) => {
      const { token, tokenId } = await seedPat(prisma, null);
      await expectRegisteredTools(await postMcp(baseUrl, toolsList, token));
      expect(limited).toEqual([`Bearer ${token}`]);
      expect(touched).toEqual([tokenId]);
    });
  });

  // Mutation: accept a user-actor token with no source PAT.
  postgresTest("UAT without a source PAT gets 401", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const { userId } = await seedPat(prisma, null);
      const uat = await signUserActorToken(SECRET, { userId, client: "test", audience: AUDIENCE });
      expect((await postMcp(baseUrl, toolsList, uat)).status).toBe(401);
    });
  });

  // Mutation: reject user-actor tokens minted from a live PAT.
  postgresTest("UAT minted from a PAT lists the registered tools", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const { userId, tokenId } = await seedPat(prisma, null);
      const uat = await signUserActorToken(SECRET, {
        userId,
        client: "test",
        pat: tokenId,
        audience: AUDIENCE,
      });
      await expectRegisteredTools(await postMcp(baseUrl, toolsList, uat));
    });
  });

  // Catches: dropping the scopeChallenge from registerMcpTools.
  postgresTest(
    "a modern call missing the tool's scope gets a 403 challenge",
    async ({ prisma }) => {
      const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
      const probe: McpToolDefinition = {
        name: "probe",
        description: "Needs read:runs",
        inputSchema: {},
        auth: { action: "read", subject: "runs" },
        handler,
      };
      await withServer(
        prisma,
        async ({ baseUrl }) => {
          const { userId, tokenId } = await seedPat(prisma, null);
          const uat = await signUserActorToken(SECRET, {
            userId,
            client: "test",
            pat: tokenId,
            audience: AUDIENCE,
            cap: ["read:projects"],
          });
          const modern = "2026-07-28";
          const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "probe",
              _meta: {
                "io.modelcontextprotocol/protocolVersion": modern,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
              },
            },
          };
          const res = await postMcp(baseUrl, request, uat, {
            "MCP-Protocol-Version": modern,
            "Mcp-Method": "tools/call",
            "Mcp-Name": "probe",
          });

          expect(res.status).toBe(403);
          const challenge = res.headers.get("www-authenticate") ?? "";
          expect(challenge).toContain('error="insufficient_scope"');
          expect(challenge).toContain('scope="read:projects read:runs"');
          expect(mocks.info).toHaveBeenCalledWith(
            "mcp.tool",
            expect.objectContaining({ tool: "probe", outcome: "insufficient_scope", userId })
          );
          expect(handler).not.toHaveBeenCalled();
        },
        [probe]
      );
    }
  );

  // Mutation: verify user-actor tokens against the default API audience.
  postgresTest("UAT minted for the API gets 401", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const { userId, tokenId } = await seedPat(prisma, null);
      const uat = await signUserActorToken(SECRET, { userId, client: "test", pat: tokenId });
      expect((await postMcp(baseUrl, toolsList, uat)).status).toBe(401);
    });
  });

  // Mutation: drop the router's body error handler.
  postgresTest.for([
    ["malformed JSON", "{not json", 400, -32700],
    ["a body over 1 MB", JSON.stringify({ pad: "x".repeat(1024 * 1024) }), 413, -32600],
  ])("valid PAT with %s gets a JSON-RPC error", async ([, body, status, code], { prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const { token } = await seedPat(prisma, null);
      const res = await postMcp(baseUrl, body, token);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code } });
    });
  });

  // Mutation: register tools without the authenticated identity.
  postgresTest("tool handlers receive the caller's identity", async ({ prisma }) => {
    const whoami: McpToolDefinition = {
      name: "whoami",
      description: "Echoes the caller",
      inputSchema: {},
      handler: async (_args, identity) => ({ content: [{ type: "text", text: identity.userId }] }),
    };
    await withServer(
      prisma,
      async ({ baseUrl }) => {
        const { token, userId } = await seedPat(prisma, null);
        const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } };
        const res = await postMcp(baseUrl, call, token);
        const body = (await res.json()) as { result: { content: { text: string }[] } };
        expect(body.result.content[0].text).toBe(userId);
      },
      [whoami]
    );
  });

  // Catches: removing the batch guard, so one rate-limited POST runs many JSON-RPC messages.
  postgresTest("JSON-RPC batch gets 400 and runs no handler", async ({ prisma }) => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const probe: McpToolDefinition = {
      name: "probe",
      description: "Counts calls",
      inputSchema: {},
      handler,
    };
    await withServer(
      prisma,
      async ({ baseUrl }) => {
        const { token } = await seedPat(prisma, null);
        const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe" } };
        const res = await postMcp(baseUrl, [call, { ...call, id: 2 }], token);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: number } };
        expect(body.error.code).toBe(-32600);
        expect(handler).not.toHaveBeenCalled();
      },
      [probe]
    );
  });

  // Mutation: let GET through to the transport.
  postgresTest("GET gets 405", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const res = await fetch(`${baseUrl}/mcp`);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });
  });

  // Mutation: point resource away from /mcp.
  postgresTest("protected resource metadata names /mcp", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const prm = (await (await fetch(`${baseUrl}${PRM_PATH}`)).json()) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(prm.resource).toBe(`${ORIGIN}/mcp`);
      expect(prm.authorization_servers).toEqual([]);
    });
  });
});
