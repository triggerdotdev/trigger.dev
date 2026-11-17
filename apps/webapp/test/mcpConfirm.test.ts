import { containerTest } from "@internal/testcontainers";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import plugin from "@trigger.dev/rbac";
import type { PrismaClient } from "@trigger.dev/database";
import { Redis, type RedisOptions } from "ioredis";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestOrgProjectWithMember, uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as Record<string | symbol, unknown>,
  rbac: undefined as unknown as Record<string, (...args: any[]) => any>,
  store: undefined as unknown,
  userId: "",
  impersonating: false,
  info: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  $replica: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
  prisma: new Proxy({}, { get: (_, prop) => mocks.db[prop] }),
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: new Proxy({}, { get: (_, prop: string) => mocks.rbac[prop] }),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: mocks.info },
}));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: mocks.userId, isImpersonating: mocks.impersonating }),
}));
vi.mock("~/mcp/confirm/storeInstance.server", () => ({
  getMcpConfirmationStore: () => mocks.store,
}));
vi.mock("~/services/sessionStorage.server", async () => {
  const { createCookieSessionStorage } = await import("@remix-run/node");
  const storage = createCookieSessionStorage({ cookie: { name: "__session", secrets: ["s"] } });
  return {
    getUserSession: (request: Request) => storage.getSession(request.headers.get("Cookie")),
    commitSession: storage.commitSession,
  };
});

import {
  canonicalJson,
  confirmationDigest,
  confirmationPreview,
} from "~/mcp/confirm/confirmation.server";
import { createMcpConfirmationStore } from "~/mcp/confirm/store.server";
import type { McpIdentity, McpSubject } from "~/mcp/gate/types";
import {
  withMcpToolAuth,
  type McpGateOptions,
  type McpToolResult,
} from "~/mcp/gate/withMcpToolAuth.server";
import { action, headers, loader } from "~/routes/mcp.confirm.$confirmationId/route";

const ok: McpToolResult = { content: [{ type: "text", text: "ok" }] };

async function setup(prisma: PrismaClient, redisOptions: RedisOptions) {
  mocks.db = prisma as unknown as Record<string | symbol, unknown>;
  mocks.rbac = plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true }) as any;

  const a = await createTestOrgProjectWithMember(prisma);
  const other = await createTestOrgProjectWithMember(prisma);
  const pat = `tr_pat_${uniqueId("tok")}`;
  const token = await prisma.personalAccessToken.create({
    data: {
      name: "mcp",
      encryptedToken: {},
      obfuscatedToken: "tr_pat_****",
      hashedToken: createHash("sha256").update(pat).digest("hex"),
      userId: a.user.id,
    },
  });
  const identity: McpIdentity = { kind: "pat", userId: a.user.id, tokenId: token.id };
  const request = new Request("https://api.trigger.dev/mcp", {
    headers: { Authorization: `Bearer ${pat}` },
  });

  const clock = { now: Date.now() };
  const store = createMcpConfirmationStore(new Redis(redisOptions), {
    origin: "https://cloud.test",
    now: () => clock.now,
  });
  mocks.store = store;

  const calls: unknown[] = [];
  const gate = (
    name = "trigger_task",
    resolveSubject?: () => Promise<McpSubject | null>,
    options: McpGateOptions = {}
  ) => {
    const tool = withMcpToolAuth(
      { action: "write", subject: "runs", confirm: true, resolveSubject },
      async (_args: unknown, ctx) => {
        calls.push(ctx.confirmation);
        return ok;
      },
      name,
      { confirmations: () => store, confirmationErrorMode: "rpc-error", ...options }
    );
    return (args: unknown) => tool(args, identity, request);
  };
  const argsA = { projectRef: a.project.externalRef, payload: { n: 1 } };
  const argsB = { projectRef: a.project.externalRef, payload: { n: 2 } };
  const call = gate();
  const pending = async (result: Promise<unknown>) => {
    const error = await result.then(
      () => null,
      (e: unknown) => e
    );
    if (!(error instanceof UrlElicitationRequiredError)) throw new Error("expected -32042");
    return error.elicitations[0] as { elicitationId: string; url: string; message: string };
  };

  return { a, other, identity, store, clock, calls, gate, call, pending, argsA, argsB };
}

async function openPage(userId: string, id: string) {
  mocks.userId = userId;
  const url = `https://cloud.test/mcp/confirm/${id}`;
  const params = { confirmationId: id };
  const page: Response = await (loader as any)({ request: new Request(url), params, context: {} });
  const body = await page.clone().json();
  const cookie = page.headers.get("Set-Cookie")!.split(";")[0]!;
  const post = (postUserId: string, token: string, decision?: string) => {
    mocks.userId = postUserId;
    const request = new Request(url, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(decision ? { csrf: token, decision } : { csrf: token }),
    });
    return (action as any)({ request, params, context: {} }).then(
      (r: Response) => r.status,
      (r: Response) => r.status
    );
  };
  return { page, body, post };
}

describe("MCP write confirmation", () => {
  // Catches: the gate running a confirm tool's handler before the user approved it.
  containerTest(
    "an unapproved call is pending and skips the handler",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);

      const error = await t.call(t.argsA).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UrlElicitationRequiredError);
      expect((error as UrlElicitationRequiredError).code).toBe(-32042);
      const [elicitation] = (error as UrlElicitationRequiredError).elicitations as any[];
      expect(elicitation.url).toBe(`https://cloud.test/mcp/confirm/${elicitation.elicitationId}`);
      expect(elicitation.message).toContain(t.a.project.name);
      expect(t.calls).toHaveLength(0);
    }
  );

  // Catches: a repeated call minting a new confirmation while one is still pending.
  containerTest(
    "a repeated call reuses the pending confirmation",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const first = await t.pending(t.call(t.argsA));

      const again = await t.pending(t.call(t.argsA));
      expect({ id: again.elicitationId, url: again.url }).toEqual({
        id: first.elicitationId,
        url: first.url,
      });
      expect((await t.pending(t.call(t.argsB))).elicitationId).not.toBe(first.elicitationId);

      const {
        id: _id,
        expiresAt: _expiresAt,
        ...record
      } = (await t.store.get(first.elicitationId, t.identity.userId))!;
      for (const other of [{ client: "uat:other" }, { tokenId: "other-token" }]) {
        const { id } = await t.store.createPending({ ...record, ...other });
        expect(id).not.toBe(first.elicitationId);
      }
    }
  );

  // Catches: deny deleting the record, so the page after the POST turns into a 404.
  containerTest(
    "a denied confirmation is a tombstone and a retry starts fresh",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const { elicitationId } = await t.pending(t.call(t.argsA));
      const record = (await t.store.get(elicitationId, t.identity.userId))!;

      expect(await t.store.deny(elicitationId, t.identity.userId)).toBe(true);
      expect((await t.store.get(elicitationId, t.identity.userId))?.deniedAt).toBeDefined();
      expect(await t.store.approve(elicitationId, t.identity.userId)).toBe(false);
      expect(await t.store.consumeApproved(record)).toBeNull();
      expect(await t.store.deny(elicitationId, t.identity.userId)).toBe(false);
      const { id: _id, expiresAt: _expiresAt, ...lookup } = record;
      expect(await t.store.createPending(lookup)).toEqual({ denied: true, id: record.id });
    }
  );

  // Catches: a denied call being retried into a fresh prompt, or never being retryable again.
  containerTest(
    "a denied call is terminal until the tombstone expires",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const first = await t.pending(t.call(t.argsA));
      await t.store.deny(first.elicitationId, t.identity.userId);

      const retry = await t.call(t.argsA).then(
        (r) => r,
        (e: unknown) => e
      );
      expect(retry).toMatchObject({ isError: true });
      expect(JSON.stringify(retry)).toContain('The user denied \\"trigger_task\\"');
      expect(t.calls).toHaveLength(0);

      t.clock.now += 61 * 1000;
      expect((await t.pending(t.call(t.argsA))).elicitationId).not.toBe(first.elicitationId);
    }
  );

  // Catches: deny discarding an approval the user already gave.
  containerTest(
    "deny after approve fails and keeps the approval",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const { elicitationId } = await t.pending(t.call(t.argsA));
      await t.store.approve(elicitationId, t.identity.userId);
      const record = (await t.store.get(elicitationId, t.identity.userId))!;

      expect(await t.store.deny(elicitationId, t.identity.userId)).toBe(false);
      expect(await t.store.consumeApproved(record)).toEqual({ id: elicitationId });
    }
  );

  // Catches: an approval for one set of args unlocking a call with different args.
  containerTest("an approval only unlocks identical args", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    expect(await t.store.approve(elicitationId, t.identity.userId)).toBe(true);

    await t.pending(t.call(t.argsB));
    expect(await t.call(t.argsA)).toEqual(ok);
    expect(t.calls).toEqual([{ id: elicitationId }]);
  });

  // Catches: an approval being reusable after the call it approved.
  containerTest("an approval is single-use", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    await t.store.approve(elicitationId, t.identity.userId);

    expect(await t.call(t.argsA)).toEqual(ok);
    await t.pending(t.call(t.argsA));
    expect(t.calls).toHaveLength(1);
  });

  // Catches: approve() accepting a user other than the one who made the call.
  containerTest("another user cannot approve", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));

    expect(await t.store.approve(elicitationId, t.other.user.id)).toBe(false);
    await t.pending(t.call(t.argsA));
    expect(t.calls).toHaveLength(0);
  });

  // Catches: an approval surviving past the record's expiry.
  containerTest("an expired approval is pending again", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    await t.store.approve(elicitationId, t.identity.userId);

    t.clock.now += 11 * 60 * 1000;
    await t.pending(t.call(t.argsA));
    expect(t.calls).toHaveLength(0);
  });

  // Catches: approving a record after it expired.
  containerTest(
    "an expired pending record cannot be approved",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const { elicitationId } = await t.pending(t.call(t.argsA));

      t.clock.now += 11 * 60 * 1000;
      expect(await t.store.approve(elicitationId, t.identity.userId)).toBe(false);
    }
  );

  // Catches: the digest or approval key dropping the tool or the resolved subject.
  containerTest(
    "an approval is bound to its tool and subject",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const second = await prisma.project.create({
        data: {
          name: "Second",
          slug: uniqueId("proj"),
          externalRef: uniqueId("proj"),
          organizationId: t.a.organization.id,
        },
      });
      const subjects = {
        first: { organizationId: t.a.organization.id, projectId: t.a.project.id },
        second: { organizationId: t.a.organization.id, projectId: second.id },
      };
      let current: McpSubject = subjects.first;
      const first = t.gate("cancel_run", async () => current);
      const other = t.gate("replay_run", async () => current);

      const { elicitationId } = await t.pending(first(t.argsA));
      await t.store.approve(elicitationId, t.identity.userId);

      await t.pending(other(t.argsA));
      current = subjects.second;
      await t.pending(first(t.argsA));
      current = subjects.first;
      expect(await first(t.argsA)).toEqual(ok);
      expect(t.calls).toHaveLength(1);
    }
  );

  // Catches: a non-atomic consume letting two concurrent calls share one approval.
  containerTest("concurrent retries consume an approval once", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    await t.store.approve(elicitationId, t.identity.userId);

    const results = await Promise.allSettled([t.call(t.argsA), t.call(t.argsA)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  // Catches: an approval from one client of a PAT being consumed by another client.
  containerTest("an approval is bound to its client", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    await t.store.approve(elicitationId, t.identity.userId);
    const record = (await t.store.get(elicitationId, t.identity.userId))!;

    expect(await t.store.consumeApproved({ ...record, client: "uat:other" })).toBeNull();
    expect(await t.store.consumeApproved(record)).toEqual({ id: elicitationId });
  });

  // Catches: tool-error mode running the handler or hiding the approval URL.
  containerTest(
    "tool-error mode returns the URL as a tool error",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);

      const result = await t.gate("trigger_task", undefined, {
        confirmationErrorMode: "tool-error",
      })(t.argsA);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("https://cloud.test/mcp/confirm/mcpc_");
      expect(t.calls).toHaveLength(0);
    }
  );

  // Catches: a store failure falling through to the handler.
  containerTest("a failing store blocks the call", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const broken = {
      ...t.store,
      consumeApproved: async () => {
        throw new Error("redis down");
      },
    };

    const result = await t.gate("trigger_task", undefined, { confirmations: () => broken })(
      t.argsA
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "The tool failed. Try again later." }],
    });
    expect(t.calls).toHaveLength(0);
  });
});

describe("confirmation preview", () => {
  // Catches: secrets shown on the confirm page, or redaction weakening the digest.
  it("fingerprints sensitive leaves but digests the real args", async () => {
    const args = { secret: "s3cr3t", nested: { apiKey: "k", headers: { authorization: ["b"] } } };
    const other = { ...args, secret: "other" };
    const preview = async (a: unknown, key = "key-1") =>
      (await confirmationPreview("t", true, a, null, key)).preview;
    const fingerprint = (v: string, key = "key-1") =>
      `[hidden hmac:${createHmac("sha256", key).update(v).digest("hex").slice(0, 8)}]`;

    expect(await preview(args)).not.toMatch(/s3cr3t|"k"|"b"/);
    expect(await preview(args)).toContain(
      `"nested":{"apiKey":"${fingerprint("k")}","headers":{"authorization":["${fingerprint("b")}"]}}`
    );
    expect(await preview(args)).toContain(fingerprint("s3cr3t"));
    expect(await preview(other)).toContain(fingerprint("other"));
    expect(confirmationDigest("t", args, null)).toBe(
      createHash("sha256")
        .update(canonicalJson({ tool: "t", args, subject: null }))
        .digest("hex")
    );
    expect(confirmationDigest("t", args, null)).not.toBe(confirmationDigest("t", other, null));
  });

  // Catches: the fingerprint ignoring its key, which makes it an offline oracle for the value.
  it("keys the fingerprint", async () => {
    const hidden = async (key: string) =>
      (await confirmationPreview("t", true, { secret: "s3cr3t" }, null, key)).preview;

    expect(await hidden("key-1")).not.toBe(await hidden("key-2"));
  });
});

describe("MCP confirm route", () => {
  // Catches: the route approving for a user other than the caller, or without the CSRF token.
  containerTest(
    "only the same user approves, with the session token",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const { elicitationId } = await t.pending(t.call(t.argsA));

      const otherLoad = await openPage(t.other.user.id, elicitationId).catch(
        (r: Response) => r.status
      );
      expect(otherLoad).toBe(404);

      const { body, post } = await openPage(t.identity.userId, elicitationId);
      const { csrf, tool } = body;
      expect(tool).toBe("trigger_task");

      expect(await post(t.identity.userId, "wrong")).toBe(403);
      expect(await post(t.other.user.id, csrf)).toBe(404);
      expect((await t.store.get(elicitationId, t.identity.userId))?.approvedAt).toBeUndefined();
      expect(await post(t.identity.userId, csrf)).toBe(200);
      expect((await t.store.get(elicitationId, t.identity.userId))?.approvedAt).toBeDefined();
    }
  );

  // Catches: an impersonating admin viewing or approving a confirmation as the user.
  containerTest(
    "an impersonating user is refused on GET and POST",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      const { elicitationId } = await t.pending(t.call(t.argsA));
      const { body, post } = await openPage(t.identity.userId, elicitationId);

      mocks.impersonating = true;
      try {
        const thrown = await openPage(t.identity.userId, elicitationId).catch((r: Response) => r);
        expect((thrown as Response).status).toBe(403);
        expect(await post(t.identity.userId, body.csrf)).toBe(403);
      } finally {
        mocks.impersonating = false;
      }
      expect((await t.store.get(elicitationId, t.identity.userId))?.approvedAt).toBeUndefined();
    }
  );

  // Catches: a consumed link answering with a bare 404 instead of the friendly page.
  containerTest("a consumed link is a 404 with no-store", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    await t.store.approve(elicitationId, t.identity.userId);
    await t.store.consumeApproved((await t.store.get(elicitationId, t.identity.userId))!);

    const thrown = await openPage(t.identity.userId, elicitationId).catch((r: Response) => r);
    expect((thrown as Response).status).toBe(404);
    expect((thrown as Response).headers.get("Cache-Control")).toBe("no-store");
  });

  // Catches: the deny route rejecting wrongly, or the page after a deny reading as not found.
  containerTest("deny through the route", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    const { body, post } = await openPage(t.identity.userId, elicitationId);

    expect(await post(t.identity.userId, "wrong", "deny")).toBe(403);
    expect(await post(t.other.user.id, body.csrf, "deny")).toBe(404);
    expect(await post(t.identity.userId, body.csrf, "bogus")).toBe(400);
    expect(await post(t.identity.userId, body.csrf, "deny")).toBe(200);

    const after = await openPage(t.identity.userId, elicitationId);
    expect(after.page.status).toBe(200);
    expect(after.body.denied).toBe(true);
    expect(await post(t.identity.userId, body.csrf, "deny")).toBe(404);
    expect(await post(t.identity.userId, body.csrf, "approve")).toBe(404);
  });

  // Catches: the decision line missing, duplicated, or carrying the wrong decision.
  containerTest(
    "each decision logs one mcp.confirmation line",
    async ({ prisma, redisOptions }) => {
      const t = await setup(prisma, redisOptions);
      for (const decision of ["approve", "deny"]) {
        const { elicitationId } = await t.pending(t.call(decision === "deny" ? t.argsB : t.argsA));
        const { body, post } = await openPage(t.identity.userId, elicitationId);
        mocks.info.mockClear();

        expect(await post(t.identity.userId, body.csrf, decision)).toBe(200);
        expect(await post(t.identity.userId, body.csrf, decision)).toBe(
          decision === "deny" ? 404 : 200
        );

        const lines = mocks.info.mock.calls.filter(([name]) => name === "mcp.confirmation");
        expect(lines).toHaveLength(1);
        expect(lines[0]![1]).toEqual({
          confirmationId: elicitationId,
          tool: "trigger_task",
          decision,
          userId: t.identity.userId,
          organizationId: t.a.organization.id,
        });
      }
    }
  );

  // Catches: a deny after approval blocking the approved call.
  containerTest("deny after approve is rejected by the route", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    const { body, post } = await openPage(t.identity.userId, elicitationId);

    expect(await post(t.identity.userId, body.csrf, "approve")).toBe(200);
    expect(await post(t.identity.userId, body.csrf, "deny")).toBe(404);
    expect(await t.call(t.argsA)).toEqual(ok);
  });

  // Catches: the HTML page (CSRF token, preview) being cacheable or frameable.
  containerTest("the page is not cached or framed", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const { elicitationId } = await t.pending(t.call(t.argsA));
    const { page } = await openPage(t.identity.userId, elicitationId);

    const document = (headers as any)({
      loaderHeaders: page.headers,
      actionHeaders: new Headers(),
      errorHeaders: undefined,
      parentHeaders: new Headers(),
    }) as Headers;

    expect(Object.fromEntries(document)).toMatchObject({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    });
    expect(document.get("set-cookie")).toContain("__session=");
  });

  // Catches: approving arguments the page could not show in full.
  containerTest("oversized arguments cannot be approved", async ({ prisma, redisOptions }) => {
    const t = await setup(prisma, redisOptions);
    const args = { ...t.argsA, payload: "x".repeat(70 * 1024) };
    const { elicitationId } = await t.pending(t.call(args));

    const { body, post } = await openPage(t.identity.userId, elicitationId);

    expect(body.truncated).toBe(true);
    expect(await post(t.identity.userId, body.csrf)).toBe(422);
    expect(await t.store.approve(elicitationId, t.identity.userId)).toBe(false);
    await t.pending(t.call(args));
    expect(t.calls).toHaveLength(0);
  });
});
