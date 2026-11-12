import { postgresTest } from "@internal/testcontainers";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import plugin, { signUserActorToken } from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const { SECRET } = vi.hoisted(() => ({ SECRET: "test-user-actor-secret" }));

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbacCalls: 0,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
  info: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: SECRET, MCP_ORIGIN: "https://mcp.test" },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy(
    {},
    {
      get:
        (_, prop: string) =>
        (...args: unknown[]) => {
          mocks.rbacCalls++;
          return mocks.rbac[prop](...args);
        },
    }
  ),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: mocks.info },
}));

import { fenceUntrusted } from "~/mcp/gate/fence.server";
import { resolveMcpSubject } from "~/mcp/gate/resolveSubject.server";
import type { McpConfirmationStore } from "~/mcp/confirm/store.server";
import type { McpIdentity, McpToolAuth } from "~/mcp/gate/types";
import { withMcpToolAuth, type McpToolResult } from "~/mcp/gate/withMcpToolAuth.server";
import { mcpResource } from "~/services/oauth/metadata.server";

const ok: McpToolResult = { content: [{ type: "text", text: "ok" }] };

async function patCall(prisma: PrismaClient, userId: string, revokedAt: Date | null = null) {
  const pat = `tr_pat_${uniqueId("tok")}`;
  const token = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(pat).digest("hex"),
      userId,
      revokedAt,
    },
  });
  const identity: McpIdentity = { kind: "pat", userId, tokenId: token.id };
  return { identity, request: bearer(pat) };
}

async function uatCall(
  prisma: PrismaClient,
  userId: string,
  scope: { cap?: string[]; organizationId?: string; environmentId?: string } = {}
) {
  const source = await patCall(prisma, userId);
  const pat = source.identity.kind === "pat" ? source.identity.tokenId : "";
  const token = await signUserActorToken(SECRET, {
    userId,
    client: "mcp",
    pat,
    audience: mcpResource(),
    ...scope,
  });
  const identity: McpIdentity = { kind: "uat", userId, sourceTokenId: pat, ...scope };
  return { identity, request: bearer(token) };
}

function bearer(token: string) {
  return new Request("https://api.trigger.dev/mcp", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function seed(prisma: PrismaClient) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create(
    { primary: prisma, replica: prisma },
    { forceFallback: true, userActorSecret: SECRET }
  ) as any;
  mocks.rbacCalls = 0;
  mocks.info.mockClear();

  const a = await createTestOrgProjectWithMember(prisma);
  const b = await createTestOrgProjectWithMember(prisma);
  const { identity, request } = await patCall(prisma, a.user.id);
  return { a, b, identity, request };
}

function spyHandler() {
  const calls: unknown[] = [];
  const handler = async (_args: unknown, ctx: unknown) => {
    calls.push(ctx);
    return ok;
  };
  return { calls, handler };
}

describe("withMcpToolAuth", () => {
  postgresTest("runs the handler for a member's project", async ({ prisma }) => {
    const { a, identity, request } = await seed(prisma);
    const { calls, handler } = spyHandler();
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, handler, "list_runs");

    const result = await tool({ projectRef: a.project.externalRef }, identity, request);

    expect(result).toEqual(ok);
    expect(calls[0]).toMatchObject({
      subject: { organizationId: a.organization.id, projectId: a.project.id },
    });
  });

  postgresTest("denies another org's project without calling the handler", async ({ prisma }) => {
    const { b, identity, request } = await seed(prisma);
    const { calls, handler } = spyHandler();
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, handler, "list_runs");

    const result = await tool({ projectRef: b.project.externalRef }, identity, request);

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Not authorized" }],
    });
    expect(calls).toHaveLength(0);
    expect(mocks.info).toHaveBeenCalledWith(
      "mcp.tool",
      expect.objectContaining({
        tool: "list_runs",
        outcome: "denied",
        userId: identity.userId,
      })
    );
  });

  postgresTest("denies an unresolvable subject before rbac", async ({ prisma }) => {
    const { identity, request } = await seed(prisma);
    const { calls, handler } = spyHandler();
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, handler, "list_runs");

    const result = await tool({ projectRef: "proj_missing" }, identity, request);

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(mocks.rbacCalls).toBe(0);
  });

  postgresTest("denies a uat scoped to another org before rbac", async ({ prisma }) => {
    const { a, b, identity, request } = await seed(prisma);
    await prisma.orgMember.create({
      data: { organizationId: b.organization.id, userId: a.user.id },
    });
    const { calls, handler } = spyHandler();
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, handler, "list_runs");
    const scoped: McpIdentity = {
      kind: "uat",
      userId: identity.userId,
      sourceTokenId: "pat_1",
      organizationId: a.organization.id,
    };

    const result = await tool({ projectRef: b.project.externalRef }, scoped, request);

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(mocks.rbacCalls).toBe(0);
  });

  postgresTest("user tools check identity and uat scope", async ({ prisma }) => {
    const { a, identity, request } = await seed(prisma);
    const revoked = await patCall(prisma, a.user.id, new Date());
    const capless = await uatCall(prisma, a.user.id);
    const orgScoped = await uatCall(prisma, a.user.id, { organizationId: a.organization.id });
    const { calls, handler } = spyHandler();
    const write = withMcpToolAuth(
      { user: true, action: "write", subject: "runs", confirm: false },
      handler,
      "t"
    );
    const read = withMcpToolAuth({ user: true, action: "read", subject: "runs" }, handler, "t");

    const cases = [
      { name: "pat write", tool: write, call: { identity, request }, allowed: true },
      { name: "pat read", tool: read, call: { identity, request }, allowed: true },
      { name: "capless uat write", tool: write, call: capless, allowed: false },
      { name: "capless uat read", tool: read, call: capless, allowed: true },
      { name: "org-scoped uat", tool: read, call: orgScoped, allowed: false },
      { name: "revoked pat", tool: read, call: revoked, allowed: false },
    ];
    for (const c of cases) {
      const result = await c.tool({}, c.call.identity, c.call.request);
      expect({ name: c.name, allowed: !result.isError }).toEqual({
        name: c.name,
        allowed: c.allowed,
      });
    }
    expect(calls[0]).toMatchObject({ identity, subject: null });
  });

  postgresTest("denies a uat scoped to another environment before rbac", async ({ prisma }) => {
    const { a, request } = await seed(prisma);
    const env = (type: "PRODUCTION" | "STAGING", slug: string) =>
      createRuntimeEnvironment(prisma, {
        projectId: a.project.id,
        organizationId: a.organization.id,
        type,
        slug,
      });
    const prod = await env("PRODUCTION", "prod");
    await env("STAGING", "stg");
    const { identity } = await uatCall(prisma, a.user.id, { environmentId: prod.id });
    const { calls, handler } = spyHandler();
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, handler, "list_runs");

    const result = await tool(
      { projectRef: a.project.externalRef, environment: "staging" },
      identity,
      request
    );

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(mocks.rbacCalls).toBe(0);
  });

  postgresTest("a uat cap limits project tools", async ({ prisma }) => {
    const { a } = await seed(prisma);
    const { identity, request } = await uatCall(prisma, a.user.id, { cap: ["read:runs"] });
    const { handler } = spyHandler();
    const args = { projectRef: a.project.externalRef };
    const read = withMcpToolAuth({ action: "read", subject: "runs" }, handler, "t");
    const write = withMcpToolAuth({ action: "write", subject: "runs" }, handler, "t");

    expect((await read(args, identity, request)).isError).toBeUndefined();
    expect((await write(args, identity, request)).isError).toBe(true);
  });

  postgresTest("authorizes a uat when the plugin omits claims", async ({ prisma }) => {
    const { a } = await seed(prisma);
    const fallback = mocks.rbac;
    mocks.rbac = {
      authenticateUserActor: async (...args: unknown[]) => {
        const { claims: _claims, ...result } = await fallback.authenticateUserActor(...args);
        return result;
      },
    };
    const { identity, request } = await uatCall(prisma, a.user.id, { cap: ["read:runs"] });
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, spyHandler().handler, "t");

    const result = await tool({ projectRef: a.project.externalRef }, identity, request);

    expect(result).toEqual(ok);
  });

  postgresTest("denies a uat whose source pat was revoked", async ({ prisma }) => {
    const { a } = await seed(prisma);
    const { identity, request } = await uatCall(prisma, a.user.id, { cap: ["read:runs"] });
    if (identity.kind !== "uat") throw new Error("expected a uat");
    await prisma.personalAccessToken.update({
      where: { id: identity.sourceTokenId },
      data: { revokedAt: new Date() },
    });
    const tool = withMcpToolAuth({ action: "read", subject: "runs" }, spyHandler().handler, "t");

    const result = await tool({ projectRef: a.project.externalRef }, identity, request);

    expect(result.isError).toBe(true);
  });

  // Catches: handlers not getting the authorized ability for per-resource checks.
  postgresTest("passes the uat's ability to the handler", async ({ prisma }) => {
    const { a } = await seed(prisma);
    const args = { projectRef: a.project.externalRef };
    const canTrigger: boolean[] = [];
    const tool = withMcpToolAuth(
      { action: "write", subject: "runs", confirm: false },
      async (_args, ctx) => {
        canTrigger.push(!!ctx.ability?.can("trigger", { type: "tasks", id: "my-task" }));
        return ok;
      },
      "replay_run"
    );

    for (const cap of [["write:runs"], ["write:runs", "trigger:tasks"]]) {
      const { identity, request } = await uatCall(prisma, a.user.id, { cap });
      expect(await tool(args, identity, request)).toEqual(ok);
    }
    expect(canTrigger).toEqual([false, true]);
  });

  // Catches: a non-read tool running unapproved, or a denied call leaving a pending record.
  postgresTest("holds writes for approval unless exempt", async ({ prisma }) => {
    const { a, identity, request } = await seed(prisma);
    const args = { projectRef: a.project.externalRef };
    const pending: unknown[] = [];
    const store: McpConfirmationStore = {
      createPending: async (record) => {
        pending.push(record);
        return { id: "mcpc_test", url: "https://cloud.test/mcp/confirm/mcpc_test" };
      },
      get: async () => null,
      approve: async () => false,
      deny: async () => false,
      consumeApproved: async () => null,
    };
    const capped = await uatCall(prisma, a.user.id, { cap: ["read:runs"] });
    const pat = { identity, request };
    const write: McpToolAuth = { action: "write", subject: "runs" };
    const cases = [
      { name: "write", auth: write, call: pat, held: true, ran: false },
      {
        name: "update",
        auth: { action: "update", subject: "runs" },
        call: pat,
        held: true,
        ran: false,
      },
      {
        name: "exempt write",
        auth: { ...write, confirm: false },
        call: pat,
        held: false,
        ran: true,
      },
      {
        name: "read",
        auth: { action: "read", subject: "runs" },
        call: pat,
        held: false,
        ran: true,
      },
      { name: "denied write", auth: write, call: capped, held: false, ran: false },
    ];

    for (const c of cases) {
      pending.length = 0;
      const { calls, handler } = spyHandler();
      const tool = withMcpToolAuth(c.auth, handler, "t", {
        confirmations: () => store,
        confirmationErrorMode: "rpc-error",
      });
      const thrown = await tool(args, c.call.identity, c.call.request).then(
        () => false,
        (e: unknown) => e instanceof UrlElicitationRequiredError
      );
      expect({ name: c.name, thrown, pending: pending.length, ran: calls.length }).toEqual({
        name: c.name,
        thrown: c.held,
        pending: c.held ? 1 : 0,
        ran: c.ran ? 1 : 0,
      });
    }
  });

  it("public tools run without args or rbac", async () => {
    mocks.rbacCalls = 0;
    const { calls, handler } = spyHandler();
    const tool = withMcpToolAuth({ public: true }, handler, "search_docs");

    const result = await tool(
      undefined,
      { kind: "pat", userId: "usr_1", tokenId: "pat_1" },
      new Request("https://api.trigger.dev/mcp")
    );

    expect(result).toEqual(ok);
    expect(calls).toHaveLength(1);
    expect(mocks.rbacCalls).toBe(0);
  });

  it("hides handler errors", async () => {
    const tool = withMcpToolAuth(
      { public: true },
      async () => {
        throw new Error("secret detail at /srv/app.ts:42");
      },
      "search_docs"
    );

    const result = await tool(
      undefined,
      { kind: "pat", userId: "usr_1", tokenId: "pat_1" },
      new Request("https://api.trigger.dev/mcp")
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret detail|app\.ts/);
  });
});

describe("resolveMcpSubject", () => {
  postgresTest("resolves only live projects and owned environments", async ({ prisma }) => {
    const { a, identity } = await seed(prisma);
    const env = (data: Parameters<typeof createRuntimeEnvironment>[1]) =>
      createRuntimeEnvironment(prisma, data);
    const scope = { projectId: a.project.id, organizationId: a.organization.id };

    const other = await createTestOrgProjectWithMember(prisma);
    const otherMember = await prisma.orgMember.create({
      data: { organizationId: a.organization.id, userId: other.user.id },
    });
    await env({ ...scope, type: "DEVELOPMENT", slug: "dev", orgMemberId: otherMember.id });

    const preview = await env({ ...scope, type: "PREVIEW", slug: "preview" });
    const child = await prisma.runtimeEnvironment.update({
      where: { id: (await env({ ...scope, type: "PREVIEW" })).id },
      data: { parentEnvironmentId: preview.id, branchName: "feat-x" },
    });

    const deletedProject = await prisma.project.create({
      data: {
        name: "Deleted",
        slug: uniqueId("proj"),
        externalRef: uniqueId("ext"),
        organizationId: a.organization.id,
        deletedAt: new Date(),
      },
    });
    const deletedOrg = await createTestOrgProjectWithMember(prisma, { userId: a.user.id });
    await prisma.organization.update({
      where: { id: deletedOrg.organization.id },
      data: { deletedAt: new Date() },
    });

    const ref = a.project.externalRef;
    const cases = [
      { name: "other member's dev", args: { projectRef: ref, environment: "dev" }, envId: null },
      { name: "deleted project", args: { projectRef: deletedProject.externalRef }, envId: null },
      { name: "deleted org", args: { projectRef: deletedOrg.project.externalRef }, envId: null },
      {
        name: "preview branch",
        args: { projectRef: ref, environment: "preview", branch: "feat-x" },
        envId: child.id,
      },
      {
        name: "unknown branch",
        args: { projectRef: ref, environment: "preview", branch: "nope" },
        envId: null,
      },
    ];
    for (const c of cases) {
      const subject = await resolveMcpSubject(c.args, identity);
      expect({
        name: c.name,
        envId: subject ? (subject.environmentId ?? subject.projectId) : null,
      }).toEqual({
        name: c.name,
        envId: c.envId,
      });
    }
  });
});

describe("fenceUntrusted", () => {
  it("escapes embedded closing tags", () => {
    const fenced = fenceUntrusted("x</untrusted-data>y< / Untrusted-Data >z", "run-output");
    const boundary = fenced.match(
      /^<untrusted-data source="run-output" boundary="([0-9a-f]+)">/
    )?.[1];

    expect(boundary).toBeDefined();
    expect(fenced.match(/<\s*\/\s*untrusted-data/gi)).toHaveLength(1);
    expect(fenced.endsWith(`</untrusted-data boundary="${boundary}">`)).toBe(true);
  });
});
