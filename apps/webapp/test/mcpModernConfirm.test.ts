import express from "express";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    SESSION_SECRET: "session-secret-for-tests",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

const IDENTITY = { kind: "pat" as const, userId: "user_1", tokenId: "tok_1" };

vi.mock("~/db.server", () => ({ $replica: {}, prisma: {} }));
vi.mock("~/v3/webhookEngine.server", () => ({ webhookEngine: {} }));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticatePat: async () => ({ ok: true, userId: "user_1", tokenId: "tok_1", ability: {} }),
  },
}));
vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));

import { createMcpRouter } from "~/mcp/server.server";
import { textResult } from "~/mcp/tools/define.server";
import { defineWriteTool } from "~/mcp/tools/defineWrite.server";
import { pending, approveAll, resetConfirmations } from "./helpers/mcpConfirm";

const MODERN = "2026-07-28";
const runs: string[] = [];
const tool = defineWriteTool({
  name: "rename_thing",
  title: "Rename Thing",
  description: "Rename a thing.",
  shape: { name: z.string() },
  approval: "configurable",
  auth: { user: true, action: "write", subject: "projects" },
  run: async (input) => {
    runs.push(input.name);
    return textResult(`renamed to ${input.name}`);
  },
});

let baseUrl = "";
let close = () => {};
beforeAll(async () => {
  const app = express();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.use(
    "/mcp",
    createMcpRouter({
      allowedOrigin: baseUrl,
      authenticate: async () => ({ ok: true, identity: IDENTITY }),
      rateLimit: (_req, _res, next) => next(),
      tools: [tool],
    })
  );
  close = () => server.close();
});
afterAll(() => close());

const URL_ELICITATION = { elicitation: { url: {} } };
const callTool = (
  id: number,
  capabilities: object = URL_ELICITATION,
  inputResponses?: Record<string, { action: string }>
) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {
    name: "rename_thing",
    arguments: { name: "new" },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": capabilities,
    },
    inputResponses,
  },
});

async function post(body: ReturnType<typeof callTool>) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "rename_thing",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("MCP 2026-07-28 write confirmation", () => {
  // Mutation: build the modern server with era "legacy" -> -32603 replaces input_required;
  // drop the gate's era check -> tool-error mode returns isError instead.
  it.each(["rpc-error", "tool-error"] as const)(
    "asks for the confirm URL as input_required in %s mode, then runs once approved",
    async (mode) => {
      resetConfirmations({ autoApprove: false, mode });
      runs.length = 0;

      const held = await post(callTool(1));
      const [record] = pending();
      expect(held).toEqual({
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: expect.objectContaining({
            resultType: "input_required",
            inputRequests: {
              [record!.id]: {
                method: "elicitation/create",
                params: {
                  mode: "url",
                  url: `https://cloud.test/mcp/confirm/${record!.id}`,
                  message: expect.stringContaining("Confirmation required"),
                },
              },
            },
          }),
        },
      });
      expect(runs).toEqual([]);

      await approveAll();
      const retried = await post(callTool(2));
      expect(retried.body.result.content).toEqual([{ type: "text", text: "renamed to new" }]);
      expect(runs).toEqual(["new"]);
    }
  );

  // Mutation: ignore inputResponses -> the client is asked again instead of getting the link.
  it.each(["cancel", "decline"])("returns the link as a tool error on %s", async (action) => {
    resetConfirmations({ autoApprove: false });
    runs.length = 0;

    await post(callTool(5));
    const [record] = pending();
    const answered = await post(callTool(6, URL_ELICITATION, { [record!.id]: { action } }));

    expect(answered.body.result).toMatchObject({ isError: true, resultType: "complete" });
    expect(answered.body.result.content[0].text).toContain(
      `https://cloud.test/mcp/confirm/${record!.id}`
    );
    expect(pending()).toEqual([record]);
    expect(runs).toEqual([]);
  });

  // Mutation: treat accept like cancel -> an unapproved accept returns a tool error.
  it("re-asks with the same id on accept until approved, then runs once", async () => {
    resetConfirmations({ autoApprove: false });
    runs.length = 0;

    await post(callTool(7));
    const [record] = pending();
    const accepted = { [record!.id]: { action: "accept" } };
    const early = await post(callTool(8, URL_ELICITATION, accepted));
    expect(early.body.result.resultType).toBe("input_required");
    expect(Object.keys(early.body.result.inputRequests)).toEqual([record!.id]);
    expect(runs).toEqual([]);

    await approveAll();
    const done = await post(callTool(9, URL_ELICITATION, accepted));
    expect(done.body.result.content).toEqual([{ type: "text", text: "renamed to new" }]);
    expect(runs).toEqual(["new"]);
  });

  // Mutation: drop the elicitation.url capability check -> the SDK answers -32021.
  it("sends the link as a tool error to a client that cannot elicit URLs", async () => {
    resetConfirmations({ autoApprove: false });
    runs.length = 0;

    const held = await post(callTool(3, {}));
    const [record] = pending();
    expect(held.status).toBe(200);
    expect(held.body.result).toMatchObject({ isError: true, resultType: "complete" });
    expect(held.body.result.content[0].text).toContain(
      `https://cloud.test/mcp/confirm/${record!.id}`
    );
    expect(runs).toEqual([]);

    await approveAll();
    const retried = await post(callTool(4, {}));
    expect(retried.body.result.content).toEqual([{ type: "text", text: "renamed to new" }]);
    expect(runs).toEqual(["new"]);
  });
});
