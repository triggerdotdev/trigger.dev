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

const ORIGIN = "https://mcp.test";
const PRM_PATH = "/.well-known/oauth-protected-resource";
const SECRET = "test-secret";

type TestServer = { baseUrl: string; limited: string[]; touched: string[] };

async function withServer(
  prisma: PrismaClient,
  fn: (server: TestServer) => Promise<void>,
  tools?: McpToolDefinition[]
) {
  const limited: string[] = [];
  const touched: string[] = [];
  const app = express();
  app.get(
    PRM_PATH,
    createMcpProtectedResourceHandler({ origin: ORIGIN, authorizationServers: [] })
  );
  app.use(
    "/mcp",
    createMcpRouter({
      authenticate: createMcpBearerAuthenticator({
        rbac: plugin.create(prisma, { forceFallback: true, userActorSecret: SECRET }),
        failureBody: (failure) => ({ error: failure.error, code: failure.code }),
        // The source-PAT liveness check of resolveAndRecheckUserActorClaims, minus env.
        recheckUserActorClaims: async (claims, bearer) => {
          const resolved = (await verifyUserActorToken(SECRET, bearer)) ?? claims;
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
      }),
      tools,
      rateLimit: (req, _res, next) => {
        limited.push(req.headers.authorization ?? "");
        next();
      },
    })
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fn({ baseUrl, limited, touched });
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

function postMcp(baseUrl: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
      const uat = await signUserActorToken(SECRET, { userId, client: "test" });
      expect((await postMcp(baseUrl, toolsList, uat)).status).toBe(401);
    });
  });

  // Mutation: reject user-actor tokens minted from a live PAT.
  postgresTest("UAT minted from a PAT lists the registered tools", async ({ prisma }) => {
    await withServer(prisma, async ({ baseUrl }) => {
      const { userId, tokenId } = await seedPat(prisma, null);
      const uat = await signUserActorToken(SECRET, { userId, client: "test", pat: tokenId });
      await expectRegisteredTools(await postMcp(baseUrl, toolsList, uat));
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
