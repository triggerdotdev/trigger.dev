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

vi.mock("~/db.server", () => ({ $replica: {}, prisma: {} }));
vi.mock("~/v3/webhookEngine.server", () => ({ webhookEngine: {} }));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticatePat: async () => ({ ok: true, userId: "user_1", tokenId: "tok_1", ability: {} }),
  },
}));
vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));

import { mcpTools, type McpToolDefinition } from "~/mcp/registry.server";
import { createMcpRouter } from "~/mcp/server.server";
import { textResult } from "~/mcp/tools/define.server";
import { defineWriteTool } from "~/mcp/tools/defineWrite.server";
import { pending, resetConfirmations } from "./helpers/mcpConfirm";

const IDENTITY = { kind: "pat" as const, userId: "user_1", tokenId: "tok_1" };
const LONG_KEY = `a-${"b".repeat(98)}`;
const EMPTY_SCHEMA_TOOLS = ["list_orgs", "list_projects"];

const runs: unknown[] = [];
const renameThing = defineWriteTool({
  name: "rename_thing",
  title: "Rename Thing",
  description: "Rename a thing.",
  shape: { name: z.string(), labels: z.array(z.string()).optional() },
  approval: "configurable",
  auth: { user: true, action: "write", subject: "projects" },
  run: async (input) => {
    runs.push(input);
    return textResult("renamed");
  },
});

const reached: { name: string; args: unknown }[] = [];
const spied = (tool: McpToolDefinition): McpToolDefinition => ({
  ...tool,
  handler: async (args) => {
    reached.push({ name: tool.name, args });
    return textResult("reached");
  },
});

let baseUrl = "";
let close = () => {};
beforeAll(async () => {
  const app = express();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const router = (tools: McpToolDefinition[]) =>
    createMcpRouter({
      allowedOrigin: baseUrl,
      authenticate: async () => ({ ok: true, identity: IDENTITY }),
      rateLimit: (_req, _res, next) => next(),
      tools,
    });
  app.use("/write", router([renameThing]));
  app.use("/all", router(mcpTools.map(spied)));
  close = () => server.close();
});
afterAll(() => close());

async function callTool(path: string, name: string, args: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result: { isError?: boolean; content: { type: string; text: string }[] };
  };
  return { isError: body.result.isError, text: body.result.content.map((c) => c.text).join("\n") };
}

describe("unknown tool arguments", () => {
  // Mutations: drop the suggestion; validate required fields first; stop listing known fields;
  // drop the affix rule, the lower-casing, the cap, the clip or the claimed-field exclusion.
  it.each([
    {
      args: { name: "x", nmae: "y" },
      has: ["Unknown field nmae; did you mean name?"],
      not: ["Known fields"],
    },
    {
      args: { name: "x", zzz: 1 },
      has: ["Unknown field zzz.", "Known fields: name, labels."],
      not: ["did you mean"],
    },
    {
      args: { nmae: "y" },
      has: ["Unknown field nmae; did you mean name?"],
      not: ["expected string"],
    },
    {
      args: { name: "x", nmae: "y", zzz: 1 },
      has: ["Unknown field nmae; did you mean name?", "Unknown field zzz.", "Known fields:"],
      not: [],
    },
    {
      args: { name: "x", "</untrusted-data>": 1 },
      has: ['<untrusted-data source="argument-name"', "<\\/untrusted-data>"],
      not: [],
    },
    {
      args: { name: "x", labelsList: [] },
      has: ["Unknown field labelsList; did you mean labels?"],
      not: ["Known fields"],
    },
    {
      args: { name: "x", NAME: "y" },
      has: ["Unknown field NAME; did you mean name?"],
      not: ["Known fields"],
    },
    {
      args: { nmae: "y", zzz: 1 },
      has: ["Unknown field nmae; did you mean name?", "Unknown field zzz.", "Known fields:"],
      not: ["zzz; did you mean"],
    },
    {
      args: {
        name: "x",
        ...Object.fromEntries([...Array(12).keys()].map((i) => [`bogus_${i}`, 1])),
      },
      has: ["Unknown field bogus_9.", "And 2 more."],
      not: ["Unknown field bogus_10"],
    },
    {
      args: { name: "x", [LONG_KEY]: 1 },
      has: [`${LONG_KEY.slice(0, 64)}…`],
      not: [LONG_KEY.slice(0, 65)],
    },
  ])("refuses $args before running or holding the call", async ({ args, has, not }) => {
    resetConfirmations({ autoApprove: false });
    runs.length = 0;

    const result = await callTool("/write", "rename_thing", args);

    expect(result.isError).toBe(true);
    for (const fragment of has) expect(result.text).toContain(fragment);
    for (const fragment of not) expect(result.text).not.toContain(fragment);
    expect(pending()).toEqual([]);
    expect(runs).toEqual([]);
  });

  // Guards the case above: without the bogus field the same call is held for confirmation.
  it("holds the same call without the unknown field", async () => {
    resetConfirmations({ autoApprove: false, mode: "tool-error" });
    await callTool("/write", "rename_thing", { name: "x" });
    expect(pending()).toHaveLength(1);
  });

  // Mutations: drop the pairing rule; list known fields only for unmatched names;
  // detect required keys by parsing undefined alone (misses the z.any() payload).
  it.each([
    {
      tool: "cancel_deployment",
      args: { environment: "prod", deployment: "o5bn22i9" },
      has: ["Unknown field deployment; did you mean shortCode?", "Known fields: "],
      not: [],
    },
    {
      tool: "trigger_task",
      args: { taskId: "my-task", input: {} },
      has: ["Unknown field input; did you mean payload?", "Known fields: "],
      not: [],
    },
    {
      tool: "trigger_task",
      args: { input: {} },
      has: ["Unknown field input.", "Known fields: "],
      not: ["did you mean"],
    },
  ])("pairs a lone unmatched field on $tool $args", async ({ tool, args, has, not }) => {
    const result = await callTool("/all", tool, args);
    for (const fragment of has) expect(result.text).toContain(fragment);
    for (const fragment of not) expect(result.text).not.toContain(fragment);
  });

  // Mutation: check unknown keys inside nested values -> the free-form payload is refused.
  it("accepts arbitrary keys inside free-form values", async () => {
    reached.length = 0;
    const payload = { anything: { deeply: ["nested", { x: 1 }] } };
    const metadata = { free: { form: true } };

    const result = await callTool("/all", "trigger_task", {
      taskId: "my-task",
      payload,
      options: { metadata },
    });

    expect(result.isError).toBeFalsy();
    expect(reached).toEqual([
      {
        name: "trigger_task",
        args: expect.objectContaining({ payload, options: expect.objectContaining({ metadata }) }),
      },
    ]);
  });

  // Mutation: register any one tool with the plain object schema -> that tool reaches its handler.
  it("refuses a bogus top-level field on every tool that declares fields", async () => {
    reached.length = 0;
    const leaked: string[] = [];
    const withFields = mcpTools.filter((tool) => Object.keys(tool.inputSchema).length > 0);
    for (const tool of withFields) {
      const result = await callTool("/all", tool.name, { bogus_field_x: 1 });
      if (!result.isError || !result.text.includes("Unknown field bogus_field_x")) {
        leaked.push(`${tool.name}: ${result.text}`);
      }
    }
    expect(leaked).toEqual([]);
    expect(reached).toEqual([]);
  });

  // Mutation: apply strictness to tools without fields -> the placeholder argument is refused.
  it.each(EMPTY_SCHEMA_TOOLS)(
    "%s ignores a placeholder argument and does not pass it on",
    async (name) => {
      reached.length = 0;
      const result = await callTool("/all", name, { random_string: "x" });
      expect(result.isError, result.text).toBeFalsy();
      expect(reached).toEqual([{ name, args: {} }]);
    }
  );

  // A new tool without fields is lenient too; list it here on purpose.
  it("knows every tool that declares no fields", () => {
    const empty = mcpTools.filter((tool) => Object.keys(tool.inputSchema).length === 0);
    expect(empty.map((tool) => tool.name).sort()).toEqual([...EMPTY_SCHEMA_TOOLS].sort());
  });
});
